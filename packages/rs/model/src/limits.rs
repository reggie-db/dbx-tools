//! Daily Databricks pay-per-token limit discovery with an embedded fallback.

use std::{collections::BTreeMap, path::Path, time::Duration};

use dbx_tools_core::{platform_cache_root, FileCache, FileCacheError};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::{
    documentation::{
        cached_documentation, collapse_text, load_page, read_snapshot, snapshot_is_fresh,
        unix_timestamp, write_snapshot, CachedDocumentation, DocumentationError,
    },
    models::{model_search_query, ServingEndpointSummary},
};

/// Databricks documentation URL for Foundation Model API limits.
pub const MODEL_RATE_LIMITS_URL: &str =
    "https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/limits";
/// Cache lifetime for documented model rate limits.
pub const MODEL_RATE_LIMITS_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const GENERATED_MODEL_RATE_LIMITS: &str = include_str!("../assets/model-rate-limits.json");

/// Published pay-per-token limits for one model.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRateLimits {
    /// Maximum input tokens admitted per minute.
    pub input_tokens_per_minute: Option<u64>,
    /// Maximum output tokens reserved per minute.
    pub output_tokens_per_minute: Option<u64>,
    /// Maximum queries admitted per hour.
    pub queries_per_hour: Option<u64>,
}

/// Model limits keyed by normalized Databricks model identity.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct ModelRateLimitCatalogue {
    models: BTreeMap<String, ModelRateLimits>,
}

impl ModelRateLimitCatalogue {
    /// Resolve limits from an endpoint name, display name, or provider identity.
    pub fn limits_for(&self, endpoint: &ServingEndpointSummary) -> Option<ModelRateLimits> {
        std::iter::once(endpoint.name.as_str())
            .chain(endpoint.display_name.as_deref())
            .chain(endpoint.model_service_name.as_deref())
            .chain(endpoint.service_names.values().map(String::as_str))
            .filter_map(model_key)
            .find_map(|key| self.models.get(&key).copied())
    }

    /// Resolve limits from a single model identity.
    pub fn limits_for_name(&self, name: &str) -> Option<ModelRateLimits> {
        model_key(name).and_then(|key| self.models.get(&key).copied())
    }
}

/// Resolves documented model rate limits with a generated snapshot fallback.
#[derive(Clone)]
pub struct ModelRateLimitsResolver {
    client: reqwest::Client,
    cache: FileCache,
    url: String,
}

impl ModelRateLimitsResolver {
    /// Create a resolver using the platform cache and Databricks limits page.
    pub fn new() -> Result<Self, ModelRateLimitsError> {
        Ok(Self::with_cache_url(
            FileCache::new(
                platform_cache_root()?
                    .join("dbx-tools")
                    .join("model")
                    .join("rate-limits.v1.json"),
                MODEL_RATE_LIMITS_TTL,
            ),
            MODEL_RATE_LIMITS_URL,
        ))
    }

    /// Create a resolver with an explicit cache and limits-page URL.
    pub fn with_cache_url(cache: FileCache, url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            cache,
            url: url.into(),
        }
    }

    /// Load the current model rate-limit catalogue.
    pub async fn rate_limits(&self) -> Result<ModelRateLimitCatalogue, ModelRateLimitsError> {
        let fallback = generated_model_rate_limits()?;
        let client = self.client.clone();
        let url = self.url.clone();
        cached_documentation(&self.cache, "model-rate-limits", || async move {
            Ok::<_, ModelRateLimitsError>(CachedDocumentation::from_result(
                load_model_rate_limits(&client, &url).await,
                fallback,
            ))
        })
        .await
    }
}

/// Parse pay-per-token limits from Databricks Foundation Model API HTML.
pub fn parse_model_rate_limits(
    html: &str,
) -> Result<ModelRateLimitCatalogue, ModelRateLimitsError> {
    let document = Html::parse_document(html);
    let table_selector = selector("table")?;
    let row_selector = selector("tr")?;
    let cell_selector = selector("th, td")?;
    let mut models = BTreeMap::new();
    for table in document.select(&table_selector) {
        let mut rows = table.select(&row_selector);
        let Some(header) = rows.next() else {
            continue;
        };
        let headers = header
            .select(&cell_selector)
            .map(collapse_text)
            .map(|value| value.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let Some(model_index) = headers.iter().position(|value| value.contains("model")) else {
            continue;
        };
        let Some(input_index) = headers.iter().position(|value| value.contains("itpm")) else {
            continue;
        };
        let Some(output_index) = headers.iter().position(|value| value.contains("otpm")) else {
            continue;
        };
        let query_index = headers.iter().position(|value| value.contains("qph"));
        for row in rows {
            let cells = row
                .select(&cell_selector)
                .map(collapse_text)
                .collect::<Vec<_>>();
            let Some(key) = cells.get(model_index).and_then(|value| model_key(value)) else {
                continue;
            };
            models.insert(
                key,
                ModelRateLimits {
                    input_tokens_per_minute: cells.get(input_index).and_then(|value| number(value)),
                    output_tokens_per_minute: cells
                        .get(output_index)
                        .and_then(|value| number(value)),
                    queries_per_hour: query_index
                        .and_then(|index| cells.get(index))
                        .and_then(|value| number(value)),
                },
            );
        }
    }
    if models.is_empty() {
        return Err(ModelRateLimitsError::NoModels);
    }
    Ok(ModelRateLimitCatalogue { models })
}

/// Refresh the generated model-rate-limit snapshot when its TTL has expired.
pub async fn refresh_generated_model_rate_limits(
    output: &Path,
) -> Result<bool, ModelRateLimitsError> {
    let generated_at = unix_timestamp().map_err(model_rate_limits_documentation_error)?;
    let existing = read_snapshot::<GeneratedModelRateLimits>(output);
    if existing.as_ref().is_some_and(|snapshot| {
        snapshot_is_fresh(snapshot.generated_at, generated_at, MODEL_RATE_LIMITS_TTL)
    }) {
        return Ok(false);
    }
    let client = reqwest::Client::new();
    let catalogue = match load_model_rate_limits(&client, MODEL_RATE_LIMITS_URL).await {
        Ok(catalogue) => catalogue,
        Err(error) if existing.is_some() => {
            tracing::warn!(%error, "model-limit snapshot refresh failed; retaining fallback");
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    write_snapshot(
        output,
        &GeneratedModelRateLimits {
            generated_at,
            catalogue,
        },
    )
    .map_err(model_rate_limits_documentation_error)?;
    Ok(true)
}

async fn load_model_rate_limits(
    client: &reqwest::Client,
    url: &str,
) -> Result<ModelRateLimitCatalogue, ModelRateLimitsError> {
    let html = load_page(client, url, "dbx-tools-model-limits/1")
        .await
        .map_err(model_rate_limits_documentation_error)?;
    parse_model_rate_limits(&html)
}

fn generated_model_rate_limits() -> Result<ModelRateLimitCatalogue, ModelRateLimitsError> {
    serde_json::from_str::<GeneratedModelRateLimits>(GENERATED_MODEL_RATE_LIMITS)
        .map(|snapshot| snapshot.catalogue)
        .map_err(ModelRateLimitsError::GeneratedSnapshot)
}

fn model_key(value: &str) -> Option<String> {
    let mut name = value.trim().trim_end_matches('*').trim();
    for suffix in ["(Public Preview)", "(Beta)", "(Preview)"] {
        name = name.strip_suffix(suffix).map_or(name, str::trim);
    }
    model_search_query(name).map(|value| value.replace(' ', "-"))
}

fn number(value: &str) -> Option<u64> {
    value.trim().replace(',', "").parse().ok()
}

fn selector(value: &str) -> Result<Selector, ModelRateLimitsError> {
    Selector::parse(value).map_err(|_| ModelRateLimitsError::InvalidSelector(value.to_owned()))
}

fn model_rate_limits_documentation_error(error: DocumentationError) -> ModelRateLimitsError {
    match error {
        DocumentationError::HttpStatus(status) => ModelRateLimitsError::HttpStatus(status),
        DocumentationError::Http(error) => ModelRateLimitsError::Http(error),
        DocumentationError::MissingParent => ModelRateLimitsError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "model-rate-limit snapshot path has no parent",
        )),
        DocumentationError::Io(error) => ModelRateLimitsError::Io(error),
        DocumentationError::Json(error) => ModelRateLimitsError::Json(error),
        DocumentationError::Time(error) => ModelRateLimitsError::Time(error),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedModelRateLimits {
    generated_at: u64,
    catalogue: ModelRateLimitCatalogue,
}

/// Errors produced while discovering or caching model rate limits.
#[derive(Debug, thiserror::Error)]
pub enum ModelRateLimitsError {
    /// The file-backed limit cache failed.
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    /// A documentation CSS selector was invalid.
    #[error("invalid model-limit selector: {0}")]
    InvalidSelector(String),
    /// The limits table contained no model rows.
    #[error("Databricks model-limit documentation contained no models")]
    NoModels,
    /// A documentation request returned an unsuccessful HTTP status.
    #[error("Databricks model-limit page returned HTTP {0}")]
    HttpStatus(u16),
    /// A documentation request failed.
    #[error("Databricks model-limit page request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// The generated fallback could not be decoded.
    #[error("generated model-rate-limit snapshot is invalid: {0}")]
    GeneratedSnapshot(serde_json::Error),
    /// A generated snapshot could not be serialized.
    #[error("model-rate-limit snapshot JSON failed: {0}")]
    Json(serde_json::Error),
    /// Snapshot file I/O failed.
    #[error("model-rate-limit snapshot I/O failed: {0}")]
    Io(std::io::Error),
    /// The system clock could not produce a snapshot timestamp.
    #[error("model-rate-limit snapshot clock failed: {0}")]
    Time(std::time::SystemTimeError),
}
