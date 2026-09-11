//! Authenticated Databricks REST client with one rejected-token retry.

use std::sync::Arc;

use http::Extensions;
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION},
    Method, Request, Response, StatusCode, Url,
};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, Middleware, Next, RequestBuilder};
use serde_json::Value;

use crate::{create_persistent_auth, AuthError, DatabricksAuthOptions, PersistentAuth};

/// Authenticated Databricks REST client with shared token lifecycle.
#[derive(Clone)]
pub struct DatabricksClient {
    auth: Arc<PersistentAuth>,
    host: String,
    http: ClientWithMiddleware,
}

#[derive(Clone)]
struct AuthorizationMiddleware {
    auth: Arc<PersistentAuth>,
}

#[async_trait::async_trait]
impl Middleware for AuthorizationMiddleware {
    async fn handle(
        &self,
        mut request: Request,
        extensions: &mut Extensions,
        next: Next<'_>,
    ) -> reqwest_middleware::Result<Response> {
        let stale_access_token = self.authorize(&mut request).await?;
        let retry_request = request.try_clone();
        let response = next.clone().run(request, extensions).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let (Some(stale_access_token), Some(mut retry_request)) =
            (stale_access_token, retry_request)
        else {
            return Ok(response);
        };
        self.auth
            .refresh_rejected_token(stale_access_token, None)
            .await
            .map_err(reqwest_middleware::Error::middleware)?;
        self.authorize(&mut retry_request).await?;
        drop(response);
        next.run(retry_request, extensions).await
    }
}

impl AuthorizationMiddleware {
    async fn authorize(&self, request: &mut Request) -> reqwest_middleware::Result<Option<String>> {
        request.headers_mut().remove(AUTHORIZATION);
        let Some(header) = self
            .auth
            .authorization_header_for_url(request.url().to_string(), None)
            .await
            .map_err(reqwest_middleware::Error::middleware)?
        else {
            return Ok(None);
        };
        let stale_access_token = header
            .split_once(' ')
            .map(|(_, access_token)| access_token)
            .unwrap_or(&header)
            .to_owned();
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&header).map_err(reqwest_middleware::Error::middleware)?,
        );
        Ok(Some(stale_access_token))
    }
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
        Self::with_host(options, None).await
    }

    /// Resolve authentication and optionally override the request base URL.
    pub async fn with_host(
        options: DatabricksAuthOptions,
        host: Option<String>,
    ) -> Result<Self, DatabricksClientError> {
        let auth = create_persistent_auth(options, None)
            .await
            .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
        Self::from_auth(auth, host)
    }

    fn from_auth(
        auth: Arc<PersistentAuth>,
        host: Option<String>,
    ) -> Result<Self, DatabricksClientError> {
        let status = auth.status();
        let host = host.unwrap_or(status.host).trim_end_matches('/').to_owned();
        if host.is_empty() {
            return Err(DatabricksClientError::Authentication(
                "resolved Databricks host is empty".into(),
            ));
        }
        let http = ClientBuilder::new(reqwest::Client::new())
            .with(AuthorizationMiddleware {
                auth: Arc::clone(&auth),
            })
            .build();
        Ok(Self { auth, host, http })
    }

    /// Return the resolved Databricks profile name.
    pub fn profile(&self) -> String {
        self.auth.status().profile
    }

    /// Return the normalized workspace or account host.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Create a middleware-enabled request builder for a relative path or absolute URL.
    pub fn request_builder(
        &self,
        path: &str,
        method: Method,
    ) -> Result<RequestBuilder, DatabricksClientError> {
        let url = match Url::parse(path) {
            Ok(url) => url,
            Err(url::ParseError::RelativeUrlWithoutBase) => {
                Url::parse(&format!("{}/", self.host))?.join(path.trim_start_matches('/'))?
            }
            Err(error) => return Err(error.into()),
        };
        Ok(self.http.request(method, url))
    }

    /// Send an authenticated JSON request and decode its successful response.
    ///
    /// An omitted method uses `POST` when a body is present and `GET` otherwise.
    pub async fn request(
        &self,
        path: &str,
        body: Option<Value>,
        method: Option<Method>,
    ) -> Result<Value, DatabricksClientError> {
        let method = method.unwrap_or_else(|| {
            if body.is_some() {
                Method::POST
            } else {
                Method::GET
            }
        });
        let mut request = self
            .request_builder(path, method)?
            .header(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
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
    /// Request middleware failed before returning a response.
    #[error("Databricks request middleware failed: {0}")]
    Middleware(reqwest_middleware::Error),
    /// The request path or configured host is not a valid URL.
    #[error("Databricks request URL is invalid: {0}")]
    Url(#[from] url::ParseError),
    /// A successful response did not contain valid JSON.
    #[error("Databricks response JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<reqwest_middleware::Error> for DatabricksClientError {
    fn from(error: reqwest_middleware::Error) -> Self {
        if let reqwest_middleware::Error::Middleware(inner) = &error {
            if inner.downcast_ref::<AuthError>().is_some() {
                return Self::Authentication(inner.to_string());
            }
        }
        Self::Middleware(error)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use reqwest::{header::HeaderValue, Method, StatusCode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn middleware_forwards_headers_and_retries_one_unauthorized_response() {
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
            host: Some(format!("http://{address}")),
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
        let response = client
            .request_builder("/serving-endpoints/embedding/invocations", Method::POST)
            .unwrap()
            .header("originator", HeaderValue::from_static("codex_cli_rs"))
            .body(br#"{"input":"hello"}"#.to_vec())
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            br#"{"data":[{"embedding":[1.0]}]}"#
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn middleware_omits_credentials_for_an_explicit_different_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let length = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
            assert!(!request.contains("authorization:"));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                )
                .await
                .unwrap();
        });
        let client = DatabricksClient::with_host(
            DatabricksAuthOptions {
                host: Some("https://credentials.example".into()),
                auth_type: Some("app_obo".into()),
                request_headers: Some(HashMap::from([(
                    "authorization".into(),
                    "Bearer test-token".into(),
                )])),
                ..Default::default()
            },
            Some(format!("http://{address}")),
        )
        .await
        .unwrap();

        client.request("/test", None, None).await.unwrap();
        server.await.unwrap();
    }
}
