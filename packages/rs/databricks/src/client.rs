//! Authenticated Databricks REST client with one rejected-token retry.

use std::sync::Arc;

use reqwest::{
    header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Method, StatusCode,
};
use serde_json::Value;

use crate::{create_persistent_auth, DatabricksAuthOptions, PersistentAuth};

/// Authenticated Databricks REST client with shared token lifecycle.
#[derive(Clone)]
pub struct DatabricksClient {
    auth: Arc<PersistentAuth>,
    host: String,
    http: reqwest::Client,
}

impl DatabricksClient {
    /// Resolve standard Databricks authentication for an optional profile.
    pub async fn new(profile: Option<String>) -> Result<Self, DatabricksClientError> {
        Self::with_options(DatabricksAuthOptions {
            profile,
            prefer_user_to_machine: false,
            ..Default::default()
        })
        .await
    }

    /// Resolve authentication from complete Databricks options.
    pub async fn with_options(
        options: DatabricksAuthOptions,
    ) -> Result<Self, DatabricksClientError> {
        let auth = create_persistent_auth(options, None)
            .await
            .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
        Self::from_auth(auth)
    }

    fn from_auth(auth: Arc<PersistentAuth>) -> Result<Self, DatabricksClientError> {
        let status = auth.status();
        let host = status.host.trim_end_matches('/').to_owned();
        if host.is_empty() {
            return Err(DatabricksClientError::Authentication(
                "resolved Databricks host is empty".into(),
            ));
        }
        Ok(Self {
            auth,
            host,
            http: reqwest::Client::new(),
        })
    }

    /// Return the resolved Databricks profile name.
    pub fn profile(&self) -> String {
        self.auth.status().profile
    }

    /// Return the normalized workspace or account host.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Send an authenticated JSON `GET` request.
    pub async fn get(&self, path: &str) -> Result<Value, DatabricksClientError> {
        self.request(Method::GET, path, None).await
    }

    /// Send an authenticated JSON `POST` request.
    pub async fn post(&self, path: &str, body: Value) -> Result<Value, DatabricksClientError> {
        self.request(Method::POST, path, Some(body)).await
    }

    /// Send an authenticated request and retry once when Databricks rejects the token.
    ///
    /// The returned response is not buffered, so callers can either read its raw bytes or
    /// consume its byte stream. Caller-provided authorization headers are ignored.
    pub async fn request_raw(
        &self,
        method: Method,
        path: &str,
        mut headers: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, DatabricksClientError> {
        headers.remove(AUTHORIZATION);
        let token = self
            .auth
            .token(Some(false))
            .await
            .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
        let mut response = self
            .send_raw(method.clone(), path, headers.clone(), body.clone(), &token)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let refreshed = self
                .auth
                .refresh_rejected_token(token.access_token)
                .await
                .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
            response = self
                .send_raw(method, path, headers, body, &refreshed)
                .await?;
        }
        Ok(response)
    }

    /// Send an authenticated JSON request and decode its successful response.
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, DatabricksClientError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            "application/json".parse().expect("valid accept header"),
        );
        let body = body.map(|value| serde_json::to_vec(&value)).transpose()?;
        if body.is_some() {
            headers.insert(
                CONTENT_TYPE,
                "application/json"
                    .parse()
                    .expect("valid content type header"),
            );
        }
        let response = self.request_raw(method, path, headers, body).await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            return Err(DatabricksClientError::Api {
                status: status.as_u16(),
                path: path.to_owned(),
                detail: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        serde_json::from_slice(&bytes).map_err(Into::into)
    }

    async fn send_raw(
        &self,
        method: Method,
        path: &str,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        token: &crate::AccessToken,
    ) -> Result<reqwest::Response, DatabricksClientError> {
        let url = format!("{}/{}", self.host, path.trim_start_matches('/'));
        let mut request = self.http.request(method, url).headers(headers).header(
            AUTHORIZATION,
            format!("{} {}", token.token_type, token.access_token),
        );
        if let Some(body) = body {
            request = request.body(body);
        }
        request.send().await.map_err(Into::into)
    }
}

/// Errors returned by [`DatabricksClient`].
#[derive(Debug, thiserror::Error)]
pub enum DatabricksClientError {
    /// Authentication could not resolve or refresh a credential.
    #[error("Databricks authentication failed: {0}")]
    Authentication(String),
    /// Databricks returned an unsuccessful API response.
    #[error("Databricks API {path} returned HTTP {status}: {detail}")]
    Api {
        /// HTTP response status.
        status: u16,
        /// Requested Databricks API path.
        path: String,
        /// Response body retained for diagnostics.
        detail: String,
    },
    /// The HTTP request failed before a response was returned.
    #[error("Databricks request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// A successful response did not contain valid JSON.
    #[error("Databricks response JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use reqwest::{
        header::{HeaderMap, HeaderValue},
        Method, StatusCode,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn raw_requests_forward_headers_and_retry_one_unauthorized_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for (status, response_body) in [
                ("401 Unauthorized", r#"{"error":"expired"}"#),
                ("200 OK", r#"{"data":[{"embedding":[1.0]}]}"#),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let length = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
                assert!(request.contains("authorization: bearer test-token"));
                assert!(request.contains("originator: codex_cli_rs"));
                assert!(request.ends_with(r#"{"input":"hello"}"#));
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response_body}",
                            response_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let config_file = directory.path().join("databrickscfg");
        std::fs::write(
            &config_file,
            format!("[DEFAULT]\nhost = http://{address}\nauth_type = pat\ntoken = test-token\n"),
        )
        .unwrap();
        let client = DatabricksClient::with_options(DatabricksAuthOptions {
            profile: Some("DEFAULT".into()),
            config_file: Some(config_file.to_string_lossy().into_owned()),
            cache_dir: Some(
                directory
                    .path()
                    .join("cache")
                    .to_string_lossy()
                    .into_owned(),
            ),
            prefer_user_to_machine: false,
            ..Default::default()
        })
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("originator", HeaderValue::from_static("codex_cli_rs"));

        let response = client
            .request_raw(
                Method::POST,
                "/serving-endpoints/embedding/invocations",
                headers,
                Some(br#"{"input":"hello"}"#.to_vec()),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            br#"{"data":[{"embedding":[1.0]}]}"#
        );
        server.await.unwrap();
    }
}
