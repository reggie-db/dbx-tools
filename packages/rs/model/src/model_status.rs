//! Daily Databricks model-retirement discovery with an embedded fallback.

use std::{collections::BTreeSet, time::Duration};

use dbx_tools_core::{platform_cache_root, FileCache, FileCacheError};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::models::ModelStatus;

pub const RETIRED_MODELS_URL: &str =
    "https://docs.databricks.com/aws/en/machine-learning/retired-models-policy";
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

#[derive(Clone)]
pub struct ModelStatusResolver {
    client: reqwest::Client,
    cache: FileCache,
    url: String,
}

impl ModelStatusResolver {
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

    pub fn with_cache_url(cache: FileCache, url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            cache,
            url: url.into(),
        }
    }

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

    pub async fn status<'a>(
        &self,
        identities: impl IntoIterator<Item = &'a str>,
    ) -> Result<ModelStatus, ModelStatusError> {
        let retired = self.retired_model_names().await?;
        Ok(status_from_names(identities, &retired))
    }
}

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

fn collapse_text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
}

async fn load_retired_models(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<String>, ModelStatusError> {
    let response = client
        .get(url)
        .header("user-agent", "dbx-tools-model-status/1")
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(ModelStatusError::HttpStatus(status.as_u16()));
    }
    parse_retired_models(&response.text().await?)
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedRetiredModels {
    models: Vec<String>,
    error: Option<String>,
    error_detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedRetiredModels {
    #[serde(rename = "generatedAt")]
    _generated_at: String,
    models: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelStatusError {
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    #[error("generated retired-model snapshot is invalid: {0}")]
    GeneratedSnapshot(serde_json::Error),
    #[error("retired-model page selectors are invalid")]
    InvalidSelector,
    #[error("Databricks retirement tables contained no model names")]
    NoModels,
    #[error("retired-model page returned HTTP {0}")]
    HttpStatus(u16),
    #[error("retired-model page request failed: {0}")]
    Http(#[from] reqwest::Error),
}
