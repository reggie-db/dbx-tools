//! Daily Databricks model-capability discovery from the public documentation.

use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dbx_tools_databricks::{platform_cache_root, FileCache, FileCacheError};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

use crate::models::{model_search_query, ServingEndpointSummary};

pub const MODEL_CAPABILITIES_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub const OPENAI_RESPONSES_MODELS_URL: &str =
    "https://docs.databricks.com/aws/en/machine-learning/model-serving/query-openai-responses";
pub const WEB_SEARCH_MODELS_URL: &str =
    "https://docs.databricks.com/aws/en/machine-learning/model-serving/web-search";

const GENERATED_MODEL_CAPABILITIES: &str = include_str!("../assets/model-capabilities.json");

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    responses: BTreeSet<String>,
    image_input: BTreeSet<String>,
    apply_patch: BTreeSet<String>,
    web_search: BTreeSet<String>,
}

impl ModelCapabilities {
    pub fn supports_image_input(&self, endpoint: &ServingEndpointSummary) -> bool {
        endpoint_matches(&self.image_input, endpoint)
    }

    pub fn supports_apply_patch(&self, endpoint: &ServingEndpointSummary) -> bool {
        endpoint_matches(&self.apply_patch, endpoint)
    }

    pub fn supports_web_search(&self, endpoint: &ServingEndpointSummary) -> bool {
        endpoint_matches(&self.web_search, endpoint)
    }

    pub fn supports_responses(&self, endpoint: &ServingEndpointSummary) -> bool {
        endpoint_matches(&self.responses, endpoint)
    }
}

#[derive(Clone)]
pub struct ModelCapabilitiesResolver {
    client: reqwest::Client,
    cache: FileCache,
    responses_url: String,
    web_search_url: String,
}

impl ModelCapabilitiesResolver {
    pub fn new() -> Result<Self, ModelCapabilitiesError> {
        Ok(Self::with_cache_urls(
            FileCache::new(
                platform_cache_root()?
                    .join("dbx-tools")
                    .join("model")
                    .join("capabilities.v1.json"),
                MODEL_CAPABILITIES_TTL,
            ),
            OPENAI_RESPONSES_MODELS_URL,
            WEB_SEARCH_MODELS_URL,
        ))
    }

    pub fn with_cache_urls(
        cache: FileCache,
        responses_url: impl Into<String>,
        web_search_url: impl Into<String>,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            cache,
            responses_url: responses_url.into(),
            web_search_url: web_search_url.into(),
        }
    }

    pub async fn capabilities(&self) -> Result<ModelCapabilities, ModelCapabilitiesError> {
        let fallback = generated_model_capabilities()?.capabilities;
        let client = self.client.clone();
        let responses_url = self.responses_url.clone();
        let web_search_url = self.web_search_url.clone();
        let snapshot = self
            .cache
            .get_or_try_init(|| async move {
                let (responses, web_search) = tokio::join!(
                    load_page(&client, &responses_url),
                    load_page(&client, &web_search_url),
                );
                let mut capabilities = fallback;
                let mut errors = Vec::new();
                match responses.and_then(|html| parse_responses_capabilities(&html)) {
                    Ok(parsed) => {
                        capabilities.responses = parsed.responses;
                        capabilities.image_input = parsed.image_input;
                        capabilities.apply_patch = parsed.apply_patch;
                    }
                    Err(error) => errors.push(error.to_string()),
                }
                match web_search.and_then(|html| parse_web_search_models(&html)) {
                    Ok(models) => capabilities.web_search = models,
                    Err(error) => errors.push(error.to_string()),
                }
                Ok::<_, ModelCapabilitiesError>(CachedModelCapabilities {
                    capabilities,
                    errors,
                })
            })
            .await?;
        for error in &snapshot.errors {
            tracing::warn!(error, "Databricks model-capability discovery failed");
        }
        Ok(snapshot.capabilities)
    }
}

pub async fn refresh_generated_model_capabilities(
    output: &Path,
) -> Result<bool, ModelCapabilitiesError> {
    let now = unix_timestamp()?;
    let existing = std::fs::read(output)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<GeneratedModelCapabilities>(&bytes).ok());
    if existing.as_ref().is_some_and(|snapshot| {
        now.saturating_sub(snapshot.generated_at) < MODEL_CAPABILITIES_TTL.as_secs()
    }) {
        return Ok(false);
    }
    let client = reqwest::Client::new();
    let loaded = tokio::try_join!(
        load_page(&client, OPENAI_RESPONSES_MODELS_URL),
        load_page(&client, WEB_SEARCH_MODELS_URL),
    );
    let (responses_html, web_search_html) = match loaded {
        Ok(loaded) => loaded,
        Err(error) if existing.is_some() => {
            tracing::warn!(%error, "model-capability snapshot refresh failed; retaining fallback");
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let snapshot = GeneratedModelCapabilities {
        generated_at: now,
        capabilities: parse_model_capabilities(&responses_html, &web_search_html)?,
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output, serde_json::to_vec_pretty(&snapshot)?)?;
    Ok(true)
}

pub fn parse_model_capabilities(
    responses_html: &str,
    web_search_html: &str,
) -> Result<ModelCapabilities, ModelCapabilitiesError> {
    let mut capabilities = parse_responses_capabilities(responses_html)?;
    capabilities.web_search = parse_web_search_models(web_search_html)?;
    Ok(capabilities)
}

fn parse_responses_capabilities(html: &str) -> Result<ModelCapabilities, ModelCapabilitiesError> {
    let document = Html::parse_document(html);
    let responses = models_after_heading(&document, "databricks-hosted-foundation-models")?;
    if responses.is_empty() {
        return Err(ModelCapabilitiesError::NoModels("OpenAI Responses"));
    }
    let input_types = section_elements(&document, "supported-input-types")?
        .into_iter()
        .map(collapse_text)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let input_type_words = input_types
        .split(|character: char| !character.is_ascii_alphanumeric())
        .collect::<BTreeSet<_>>();
    let image_input = input_type_words.contains("text") && input_type_words.contains("image");
    let apply_patch = code_values_after_heading(&document, "limitations")?
        .into_iter()
        .any(|value| value == "apply_patch");
    Ok(ModelCapabilities {
        image_input: if image_input {
            responses.clone()
        } else {
            BTreeSet::new()
        },
        apply_patch: if apply_patch {
            responses.clone()
        } else {
            BTreeSet::new()
        },
        responses,
        web_search: BTreeSet::new(),
    })
}

fn parse_web_search_models(html: &str) -> Result<BTreeSet<String>, ModelCapabilitiesError> {
    let document = Html::parse_document(html);
    let models = models_after_heading(&document, "openai-models")?;
    if models.is_empty() {
        return Err(ModelCapabilitiesError::NoModels("OpenAI web search"));
    }
    Ok(models)
}

fn models_after_heading(
    document: &Html,
    heading_id: &str,
) -> Result<BTreeSet<String>, ModelCapabilitiesError> {
    Ok(code_values_after_heading(document, heading_id)?
        .into_iter()
        .filter_map(|value| model_key(&value))
        .collect())
}

fn code_values_after_heading(
    document: &Html,
    heading_id: &str,
) -> Result<Vec<String>, ModelCapabilitiesError> {
    let code_selector = selector("code")?;
    let mut values = Vec::new();
    for element in section_elements(document, heading_id)? {
        if element.value().name() == "code" {
            values.push(collapse_text(element));
        }
        values.extend(element.select(&code_selector).map(collapse_text));
    }
    Ok(values)
}

fn section_elements<'a>(
    document: &'a Html,
    heading_id: &str,
) -> Result<Vec<scraper::ElementRef<'a>>, ModelCapabilitiesError> {
    let heading_selector = selector(&format!("#{heading_id}"))?;
    let heading = document
        .select(&heading_selector)
        .next()
        .ok_or_else(|| ModelCapabilitiesError::MissingSection(heading_id.to_owned()))?;
    let level = heading_level(heading.value().name())
        .ok_or_else(|| ModelCapabilitiesError::InvalidHeading(heading_id.to_owned()))?;
    let mut elements = Vec::new();
    let mut sibling = heading.next_sibling();
    while let Some(node) = sibling {
        sibling = node.next_sibling();
        let Some(element) = scraper::ElementRef::wrap(node) else {
            continue;
        };
        if heading_level(element.value().name()).is_some_and(|candidate| candidate <= level) {
            break;
        }
        elements.push(element);
    }
    Ok(elements)
}

fn heading_level(name: &str) -> Option<u8> {
    name.strip_prefix('h')?.parse().ok()
}

fn endpoint_matches(models: &BTreeSet<String>, endpoint: &ServingEndpointSummary) -> bool {
    std::iter::once(endpoint.name.as_str())
        .chain(endpoint.model_service_name.as_deref())
        .chain(endpoint.service_names.values().map(String::as_str))
        .filter_map(model_key)
        .any(|key| models.contains(&key))
}

fn model_key(value: &str) -> Option<String> {
    model_search_query(value).map(|value| value.replace(' ', "-"))
}

fn selector(value: &str) -> Result<Selector, ModelCapabilitiesError> {
    Selector::parse(value).map_err(|_| ModelCapabilitiesError::InvalidSelector(value.to_owned()))
}

fn collapse_text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
}

async fn load_page(client: &reqwest::Client, url: &str) -> Result<String, ModelCapabilitiesError> {
    let response = client
        .get(url)
        .header("user-agent", "dbx-tools-model-capabilities/1")
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(ModelCapabilitiesError::HttpStatus(status.as_u16()));
    }
    Ok(response.text().await?)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedModelCapabilities {
    capabilities: ModelCapabilities,
    errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedModelCapabilities {
    generated_at: u64,
    capabilities: ModelCapabilities,
}

fn generated_model_capabilities() -> Result<GeneratedModelCapabilities, ModelCapabilitiesError> {
    serde_json::from_str(GENERATED_MODEL_CAPABILITIES)
        .map_err(ModelCapabilitiesError::GeneratedSnapshot)
}

fn unix_timestamp() -> Result<u64, ModelCapabilitiesError> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

#[derive(Debug, thiserror::Error)]
pub enum ModelCapabilitiesError {
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    #[error("invalid capability selector: {0}")]
    InvalidSelector(String),
    #[error("Databricks capability page is missing section {0}")]
    MissingSection(String),
    #[error("Databricks capability section {0} is not a heading")]
    InvalidHeading(String),
    #[error("Databricks documentation contained no {0} models")]
    NoModels(&'static str),
    #[error("Databricks capability page returned HTTP {0}")]
    HttpStatus(u16),
    #[error("Databricks capability page request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("generated model-capability snapshot is invalid: {0}")]
    GeneratedSnapshot(serde_json::Error),
    #[error("model-capability snapshot I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("system time is before the Unix epoch: {0}")]
    Time(#[from] std::time::SystemTimeError),
    #[error("model-capability snapshot JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}
