//! Daily Databricks model-retirement discovery with an embedded fallback.

use std::{collections::BTreeSet, path::Path, time::Duration};

use dbx_tools_databricks::{platform_cache_root, FileCache, FileCacheError};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::{
    documentation::{
        collapse_text, load_page, read_snapshot, snapshot_is_fresh, unix_timestamp, write_snapshot,
        DocumentationError,
    },
    models::ModelStatus,
};

/// Databricks documentation URL for retired foundation models.
pub const RETIRED_MODELS_URL: &str =
    "https://docs.databricks.com/aws/en/machine-learning/retired-models-policy";
/// Cache lifetime for model retirement metadata.
pub const RETIRED_MODELS_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const GENERATED_RETIRED_MODELS: &str = include_str!("../assets/retired-models.json");
const MODEL_PREFIXES: &[&str] = &[
    "ai",
    "anthropic",
    "databricks",
    "dbx",
    "google",
    "meta",
    "openai",
    "system",
];

/// Resolves model retirement status with a generated snapshot fallback.
#[derive(Clone)]
pub struct ModelStatusResolver {
    client: reqwest::Client,
    cache: FileCache,
    url: String,
}

impl ModelStatusResolver {
    /// Create a resolver using the platform cache and Databricks retirement page.
    pub fn new() -> Result<Self, ModelStatusError> {
        Ok(Self::with_cache_url(
            FileCache::new(
                platform_cache_root()?
                    .join("dbx-tools")
                    .join("model")
                    .join("retired-models.v1.json"),
                RETIRED_MODELS_TTL,
            ),
            RETIRED_MODELS_URL,
        ))
    }

    /// Create a resolver with an explicit cache and retirement-page URL.
    pub fn with_cache_url(cache: FileCache, url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            cache,
            url: url.into(),
        }
    }

    /// Load the current set of retired model names.
    pub async fn retired_model_names(&self) -> Result<BTreeSet<String>, ModelStatusError> {
        let fallback = generated_retired_models()?;
        let client = self.client.clone();
        let url = self.url.clone();
        let snapshot = self
            .cache
            .get_or_try_init(|| async move {
                let loaded = load_retired_models(&client, &url).await;
                Ok::<_, ModelStatusError>(match loaded {
                    Ok(models) => CachedRetiredModels {
                        models,
                        error: None,
                        error_detail: None,
                    },
                    Err(error) => CachedRetiredModels {
                        models: fallback,
                        error: Some(error.to_string()),
                        error_detail: Some(format!("{error:?}")),
                    },
                })
            })
            .await?;
        if let Some(error) = snapshot.error.as_deref() {
            tracing::warn!(
                error,
                "Databricks retired-model refresh failed; using generated fallback"
            );
        }
        Ok(snapshot.models.into_iter().collect())
    }

    /// Resolve retirement status across one or more endpoint identities.
    pub async fn status<'a>(
        &self,
        identities: impl IntoIterator<Item = &'a str>,
    ) -> Result<ModelStatus, ModelStatusError> {
        let retired = self.retired_model_names().await?;
        Ok(status_from_names(identities, &retired))
    }
}

/// Parse retired model names from Databricks retirement-policy HTML.
pub fn parse_retired_models(html: &str) -> Result<Vec<String>, ModelStatusError> {
    let document = Html::parse_document(html);
    let table_selector = Selector::parse("table").map_err(|_| ModelStatusError::InvalidSelector)?;
    let row_selector = Selector::parse("tr").map_err(|_| ModelStatusError::InvalidSelector)?;
    let cell_selector = Selector::parse("th, td").map_err(|_| ModelStatusError::InvalidSelector)?;
    let mut names = BTreeSet::new();
    for table in document.select(&table_selector) {
        let mut rows = table.select(&row_selector);
        let Some(header) = rows
            .next()
            .and_then(|row| row.select(&cell_selector).next())
            .map(collapse_text)
        else {
            continue;
        };
        if !matches!(
            header.to_ascii_lowercase().as_str(),
            "open model" | "partner model"
        ) {
            continue;
        }
        for row in rows {
            if let Some(cell) = row.select(&cell_selector).next() {
                for name in collapse_text(cell).split('/') {
                    let name = name.trim();
                    if !name.is_empty() {
                        names.insert(name.to_owned());
                    }
                }
            }
        }
    }
    if names.is_empty() {
        return Err(ModelStatusError::NoModels);
    }
    let mut names = names.into_iter().collect::<Vec<_>>();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(names)
}

/// Refresh the generated retired-model snapshot when its TTL has expired.
pub async fn refresh_generated_retired_models(output: &Path) -> Result<bool, ModelStatusError> {
    let generated_at = unix_timestamp().map_err(model_status_documentation_error)?;
    let existing = read_snapshot::<GeneratedRetiredModels>(output);
    if existing.as_ref().is_some_and(|snapshot| {
        snapshot_is_fresh(snapshot.generated_at, generated_at, RETIRED_MODELS_TTL)
    }) {
        return Ok(false);
    }
    let client = reqwest::Client::new();
    let models = match load_retired_models(&client, RETIRED_MODELS_URL).await {
        Ok(models) => models,
        Err(error) if existing.is_some() => {
            tracing::warn!(%error, "retired-model snapshot refresh failed; retaining fallback");
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let snapshot = GeneratedRetiredModels {
        generated_at,
        models,
    };
    write_snapshot(output, &snapshot).map_err(model_status_documentation_error)?;
    Ok(true)
}

/// Determine whether any supplied model identity matches a retired model.
pub fn status_from_names<'a>(
    identities: impl IntoIterator<Item = &'a str>,
    retired: &BTreeSet<String>,
) -> ModelStatus {
    let keys = retired
        .iter()
        .map(|name| model_key(name))
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    ModelStatus {
        deprecated: identities.into_iter().any(|identity| {
            let candidate = model_key(identity);
            keys.iter()
                .any(|key| candidate == *key || candidate.starts_with(&format!("{key}-")))
        }),
    }
}

async fn load_retired_models(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<String>, ModelStatusError> {
    let html = load_page(client, url, "dbx-tools-model-status/1")
        .await
        .map_err(model_status_documentation_error)?;
    parse_retired_models(&html)
}

fn generated_retired_models() -> Result<Vec<String>, ModelStatusError> {
    serde_json::from_str::<GeneratedRetiredModels>(GENERATED_RETIRED_MODELS)
        .map(|snapshot| snapshot.models)
        .map_err(ModelStatusError::GeneratedSnapshot)
}

fn model_key(value: &str) -> String {
    let normalized = value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>();
    let mut tokens = normalized.split_whitespace().collect::<Vec<_>>();
    while tokens
        .first()
        .is_some_and(|token| MODEL_PREFIXES.contains(token))
    {
        tokens.remove(0);
    }
    tokens.join("-")
}

fn model_status_documentation_error(error: DocumentationError) -> ModelStatusError {
    match error {
        DocumentationError::HttpStatus(status) => ModelStatusError::HttpStatus(status),
        DocumentationError::Http(error) => ModelStatusError::Http(error),
        DocumentationError::MissingParent => ModelStatusError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "retired-model snapshot path has no parent",
        )),
        DocumentationError::Io(error) => ModelStatusError::Io(error),
        DocumentationError::Json(error) => ModelStatusError::Json(error),
        DocumentationError::Time(error) => ModelStatusError::Time(error),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedRetiredModels {
    models: Vec<String>,
    error: Option<String>,
    error_detail: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedRetiredModels {
    generated_at: u64,
    models: Vec<String>,
}

/// Errors produced while discovering or caching retired models.
#[derive(Debug, thiserror::Error)]
pub enum ModelStatusError {
    /// The file-backed retirement cache failed.
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    /// The generated retired-model snapshot could not be decoded.
    #[error("generated retired-model snapshot is invalid: {0}")]
    GeneratedSnapshot(serde_json::Error),
    /// A retirement-page CSS selector was invalid.
    #[error("retired-model page selectors are invalid")]
    InvalidSelector,
    /// The retirement page contained no supported model tables.
    #[error("Databricks retirement tables contained no model names")]
    NoModels,
    /// The retirement-page request returned an unsuccessful HTTP status.
    #[error("retired-model page returned HTTP {0}")]
    HttpStatus(u16),
    /// The retirement-page request failed.
    #[error("retired-model page request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// Reading or writing a retired-model snapshot failed.
    #[error("retired-model snapshot I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// A retired-model snapshot could not be encoded or decoded as JSON.
    #[error("retired-model snapshot JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    /// The system clock could not provide a Unix timestamp.
    #[error("system time is before the Unix epoch: {0}")]
    Time(#[from] std::time::SystemTimeError),
}
