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
    #[error(
        "estimated input tokens {estimated_input_tokens} exceed the configured per-minute budget {input_limit} for {model}"
    )]
    OversizedInput {
        model: String,
        estimated_input_tokens: u64,
        input_limit: u64,
    },
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Databricks request failed: {0}")]
    Databricks(#[from] DatabricksClientError),
    #[error("model resolution failed: {0}")]
    Model(#[from] ModelError),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        if let Self::OversizedInput {
            model,
            estimated_input_tokens,
            input_limit,
        } = self
        {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": {
                        "message": "Estimated input exceeds the active per-minute token budget. Compact context, reduce attachments, split the task, or select a model/profile with sufficient quota.",
                        "type": "local_rate_limit_exceeded",
                        "code": 429,
                        "limit_type": "input_tokens_per_minute",
                        "model": model,
                        "estimated_input_tokens": estimated_input_tokens,
                        "limit": input_limit
                    }
                })),
            )
                .into_response();
        }
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
            Self::Upstream(_)
            | Self::Translation(_)
            | Self::Databricks(_)
            | Self::Model(_)
            | Self::OversizedInput { .. } => StatusCode::BAD_GATEWAY,
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
