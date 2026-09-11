//! HTTP error mapping for proxy routes.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use dbx_tools_core::DatabricksClientError;
use dbx_tools_model::ModelError;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ProxyError {
    #[error("request body must include a string model")]
    MissingModel,
    #[error("no embedding serving endpoint matched {0}")]
    EmbeddingModelNotFound(String),
    #[error("upstream request failed: {0}")]
    Upstream(String),
    #[error("protocol translation failed: {0}")]
    Translation(String),
    #[error("unsupported protocol route: {0}")]
    Unsupported(String),
    #[error("invalid image input: {0}")]
    Image(String),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Databricks request failed: {0}")]
    Databricks(#[from] DatabricksClientError),
    #[error("model resolution failed: {0}")]
    Model(#[from] ModelError),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::MissingModel
            | Self::EmbeddingModelNotFound(_)
            | Self::Image(_)
            | Self::Json(_)
            | Self::Unsupported(_) => StatusCode::BAD_REQUEST,
            Self::Databricks(DatabricksClientError::Authentication(_))
            | Self::Model(ModelError::Databricks(DatabricksClientError::Authentication(_))) => {
                StatusCode::UNAUTHORIZED
            }
            Self::Upstream(_) | Self::Translation(_) | Self::Databricks(_) | Self::Model(_) => {
                StatusCode::BAD_GATEWAY
            }
        };
        (
            status,
            Json(json!({
                "error": {"message": self.to_string(), "type": "proxy_error"}
            })),
        )
            .into_response()
    }
}
