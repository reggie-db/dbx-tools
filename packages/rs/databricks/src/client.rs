//! Authenticated Databricks REST client with one rejected-token retry.

use std::{collections::HashMap, sync::Arc};

use reqwest::{Method, StatusCode};
use serde_json::Value;

use crate::{
    create_persistent_auth, create_persistent_auth_for_request, DatabricksAuthOptions,
    PersistentAuth, Storage,
};

#[derive(Clone)]
pub struct DatabricksClient {
    auth: Arc<PersistentAuth>,
    host: String,
    http: reqwest::Client,
}

impl DatabricksClient {
    pub async fn new(profile: Option<String>) -> Result<Self, DatabricksClientError> {
        Self::with_options(DatabricksAuthOptions {
            profile,
            prefer_user_to_machine: false,
            ..Default::default()
        })
        .await
    }

    pub async fn with_options(
        options: DatabricksAuthOptions,
    ) -> Result<Self, DatabricksClientError> {
        let auth = create_persistent_auth(options, None)
            .await
            .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
        Self::from_auth(auth)
    }

    pub async fn for_request(
        options: DatabricksAuthOptions,
        request_headers: HashMap<String, String>,
        storage: Option<Storage>,
    ) -> Result<Self, DatabricksClientError> {
        let auth = create_persistent_auth_for_request(options, request_headers, storage)
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

    pub fn profile(&self) -> String {
        self.auth.status().profile
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub async fn get(&self, path: &str) -> Result<Value, DatabricksClientError> {
        self.request(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value, DatabricksClientError> {
        self.request(Method::POST, path, Some(body)).await
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, DatabricksClientError> {
        let token = self
            .auth
            .token(Some(false))
            .await
            .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
        let mut response = self
            .send(method.clone(), path, body.as_ref(), &token)
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let refreshed = self
                .auth
                .refresh_rejected_token(token.access_token)
                .await
                .map_err(|error| DatabricksClientError::Authentication(error.to_string()))?;
            response = self.send(method, path, body.as_ref(), &refreshed).await?;
        }
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

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        token: &crate::AccessToken,
    ) -> Result<reqwest::Response, DatabricksClientError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.host, path))
            .header("accept", "application/json")
            .header(
                "authorization",
                format!("{} {}", token.token_type, token.access_token),
            );
        if let Some(body) = body {
            request = request.json(body);
        }
        request.send().await.map_err(Into::into)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DatabricksClientError {
    #[error("Databricks authentication failed: {0}")]
    Authentication(String),
    #[error("Databricks API {path} returned HTTP {status}: {detail}")]
    Api {
        status: u16,
        path: String,
        detail: String,
    },
    #[error("Databricks request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Databricks response JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}
