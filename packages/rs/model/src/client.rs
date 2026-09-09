//! Live Databricks endpoint discovery with a file-backed TTL cache.

use std::{collections::BTreeMap, time::Duration};

use dbx_tools_databricks::{
    platform_cache_root, DatabricksClient, DatabricksClientError, FileCache, FileCacheError,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    classify::{classify_endpoints, supports_tools_by_family},
    model_status::{status_from_names, ModelStatusError, ModelStatusResolver},
    models::{
        model_search_query, model_service_names, ModelClass, ModelProfile, ModelQuery,
        ServingEndpointSummary,
    },
    reasoning::reasoning_efforts_for_names,
    resolve::{lookup_models, rank_model_id, DEFAULT_FUZZY_THRESHOLD},
};

/// Default lifetime for cached Model Serving endpoint metadata.
pub const DEFAULT_MODEL_CACHE_TTL: Duration = Duration::from_secs(300);
const MODEL_CACHE_VERSION: u8 = 3;

/// Client for discovering, caching, and resolving Databricks Model Serving endpoints.
#[derive(Clone)]
pub struct ModelClient {
    client: DatabricksClient,
    cache: FileCache,
    status: ModelStatusResolver,
}

impl ModelClient {
    /// Create a model client with the default file-backed cache.
    pub fn new(client: DatabricksClient) -> Result<Self, ModelError> {
        Self::with_cache_ttl(client, DEFAULT_MODEL_CACHE_TTL)
    }

    /// Create a model client with an explicit endpoint-cache lifetime.
    pub fn with_cache_ttl(
        client: DatabricksClient,
        cache_ttl: Duration,
    ) -> Result<Self, ModelError> {
        assert!(!cache_ttl.is_zero(), "model cache TTL must be positive");
        let key = format!("{:x}", Sha256::digest(client.host().as_bytes()));
        let cache = FileCache::new(
            platform_cache_root()?
                .join("dbx-tools")
                .join("model")
                .join(format!("{key}.v{MODEL_CACHE_VERSION}.json")),
            cache_ttl,
        );
        Ok(Self {
            client,
            cache,
            status: ModelStatusResolver::new()?,
        })
    }

    /// Create a model client with an explicit endpoint cache.
    pub fn with_cache(client: DatabricksClient, cache: FileCache) -> Result<Self, ModelError> {
        Ok(Self::with_cache_and_status(
            client,
            cache,
            ModelStatusResolver::new()?,
        ))
    }

    /// Create a model client with explicit endpoint and retirement-status caches.
    pub fn with_cache_and_status(
        client: DatabricksClient,
        cache: FileCache,
        status: ModelStatusResolver,
    ) -> Self {
        Self {
            client,
            cache,
            status,
        }
    }

    /// List cached serving endpoint summaries, optionally forcing a live refresh.
    pub async fn list_serving_endpoints(
        &self,
        force: bool,
    ) -> Result<Vec<ServingEndpointSummary>, ModelError> {
        if force {
            self.cache.refresh(|| self.fetch_models()).await
        } else {
            self.cache.get_or_try_init(|| self.fetch_models()).await
        }
    }

    /// Resolve a loose model name to a serving endpoint name.
    pub async fn resolve_model(&self, requested: &str) -> Result<String, ModelError> {
        Ok(self
            .resolve_serving_endpoint(requested)
            .await?
            .map(|endpoint| endpoint.name)
            .unwrap_or_else(|| requested.to_owned()))
    }

    /// Resolve a loose model name to its serving endpoint summary.
    pub async fn resolve_serving_endpoint(
        &self,
        requested: &str,
    ) -> Result<Option<ServingEndpointSummary>, ModelError> {
        let endpoints = self.list_serving_endpoints(false).await?;
        let resolved = resolve_from_endpoints(&endpoints, requested);
        if resolved != requested || endpoints.iter().any(|endpoint| endpoint.name == requested) {
            return Ok(endpoints
                .into_iter()
                .find(|endpoint| endpoint.name == resolved));
        }
        let endpoints = self.list_serving_endpoints(true).await?;
        let resolved = resolve_from_endpoints(&endpoints, requested);
        Ok(endpoints
            .into_iter()
            .find(|endpoint| endpoint.name == resolved))
    }

    /// Resolve a loose model name within one model class.
    pub async fn resolve_serving_endpoint_for_class(
        &self,
        requested: &str,
        model_class: ModelClass,
    ) -> Result<Option<ServingEndpointSummary>, ModelError> {
        let endpoints = self.list_serving_endpoints(false).await?;
        if let Some(endpoint) = resolve_from_endpoints_for_class(&endpoints, requested, model_class)
        {
            return Ok(Some(endpoint));
        }
        let endpoints = self.list_serving_endpoints(true).await?;
        Ok(resolve_from_endpoints_for_class(
            &endpoints,
            requested,
            model_class,
        ))
    }

    async fn fetch_models(&self) -> Result<Vec<ServingEndpointSummary>, ModelError> {
        let value = self.client.get("/api/2.0/serving-endpoints").await?;
        let retired = self.status.retired_model_names().await?;
        endpoints_from_response_with_retired(&value, &retired)
    }
}

fn resolve_from_endpoints(endpoints: &[ServingEndpointSummary], requested: &str) -> String {
    let search = if endpoints.iter().any(|endpoint| endpoint.name == requested) {
        requested.to_owned()
    } else {
        model_search_query(requested).unwrap_or_else(|| requested.to_owned())
    };
    rank_model_id(endpoints, &search, DEFAULT_FUZZY_THRESHOLD).model_id
}

fn resolve_from_endpoints_for_class(
    endpoints: &[ServingEndpointSummary],
    requested: &str,
    model_class: ModelClass,
) -> Option<ServingEndpointSummary> {
    let search = if endpoints.iter().any(|endpoint| endpoint.name == requested) {
        requested.to_owned()
    } else {
        model_search_query(requested).unwrap_or_else(|| requested.to_owned())
    };
    lookup_models(
        endpoints,
        &ModelQuery {
            search: Some(search),
            model_class: Some(model_class),
            limit: Some(1),
            ..Default::default()
        },
    )
    .into_iter()
    .next()
    .map(|ranked| ranked.endpoint)
}

/// Parse a Databricks serving-endpoints response into endpoint summaries.
pub fn endpoints_from_response(value: &Value) -> Result<Vec<ServingEndpointSummary>, ModelError> {
    endpoints_from_response_with_retired(value, &Default::default())
}

fn endpoints_from_response_with_retired(
    value: &Value,
    retired: &std::collections::BTreeSet<String>,
) -> Result<Vec<ServingEndpointSummary>, ModelError> {
    let endpoints = value
        .get("endpoints")
        .and_then(Value::as_array)
        .ok_or(ModelError::InvalidResponse("missing endpoints array"))?;
    let mut summaries = endpoints
        .iter()
        .filter_map(|endpoint| endpoint_summary(endpoint, retired))
        .collect::<Vec<_>>();
    let classes = classify_endpoints(&summaries)
        .into_iter()
        .map(|(model_class, endpoint)| (endpoint.name, model_class))
        .collect::<BTreeMap<_, _>>();
    for summary in &mut summaries {
        summary.model_class = classes.get(&summary.name).copied();
    }
    Ok(summaries)
}

fn endpoint_summary(
    endpoint: &Value,
    retired: &std::collections::BTreeSet<String>,
) -> Option<ServingEndpointSummary> {
    let name = endpoint.get("name")?.as_str()?.to_owned();
    let identities = model_identities(endpoint, &name);
    Some(ServingEndpointSummary {
        display_name: provided_display_name(endpoint).or_else(|| Some(model_display_name(&name))),
        task: string_at(endpoint, &["task"]),
        state: string_at(endpoint, &["state", "ready"]),
        description: string_at(endpoint, &["description"]),
        supports_tools: Some(supports_tools_by_family(&name)),
        profile: model_profile(endpoint),
        model_class: None,
        service_names: identities
            .iter()
            .flat_map(|identity| model_service_names(identity))
            .collect(),
        model_service_name: model_service_name(endpoint),
        reasoning_efforts: reasoning_efforts_for_names(identities.iter().map(String::as_str)),
        status: status_from_names(identities.iter().map(String::as_str), retired),
        name,
    })
}

fn model_identities(endpoint: &Value, endpoint_name: &str) -> Vec<String> {
    let mut identities = vec![endpoint_name.to_owned()];
    for entity in endpoint
        .pointer("/config/served_entities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for pointer in [
            "/entity_name",
            "/foundation_model/name",
            "/external_model/name",
        ] {
            if let Some(value) = entity.pointer(pointer).and_then(Value::as_str) {
                identities.push(value.to_owned());
            }
        }
    }
    identities
}

fn model_service_name(endpoint: &Value) -> Option<String> {
    endpoint
        .pointer("/config/served_entities")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|entity| {
            entity
                .pointer("/foundation_model/name")
                .or_else(|| entity.pointer("/entity_name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
}

fn model_profile(endpoint: &Value) -> Option<ModelProfile> {
    endpoint
        .pointer("/config/served_entities")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|entity| {
            let profile = entity.pointer("/foundation_model/ai_gateway_model_profile")?;
            let result = ModelProfile {
                quality: finite_number(profile.get("quality")),
                speed: finite_number(profile.get("speed")),
                cost: finite_number(profile.get("cost")),
            };
            (result.quality.is_some() || result.speed.is_some() || result.cost.is_some())
                .then_some(result)
        })
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn provided_display_name(endpoint: &Value) -> Option<String> {
    if let Some(tags) = endpoint.get("tags").and_then(Value::as_array) {
        for tag in tags {
            if matches!(
                tag.get("key").and_then(Value::as_str),
                Some("display_name" | "displayName" | "name")
            ) {
                if let Some(value) = tag
                    .get("value")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(value.to_owned());
                }
            }
        }
    }
    endpoint
        .pointer("/config/served_entities")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|entity| {
            entity
                .pointer("/external_model/name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
}

fn model_display_name(name: &str) -> String {
    let mut segments = split_model_name(name);
    while matches!(
        segments.first().map(String::as_str),
        Some("databricks" | "system" | "dbx")
    ) {
        segments.remove(0);
        if segments.first().is_some_and(|segment| segment == "ai") {
            segments.remove(0);
        }
    }
    let mut pieces = Vec::new();
    let mut numeric = Vec::new();
    for segment in segments {
        if segment.chars().all(|character| character.is_ascii_digit()) {
            numeric.push(segment);
            continue;
        }
        if !numeric.is_empty() {
            pieces.push(numeric.join("."));
            numeric.clear();
        }
        let lower = segment.to_ascii_lowercase();
        let piece = if matches!(
            lower.as_str(),
            "gpt" | "gte" | "bge" | "dbrx" | "oss" | "llm" | "moe" | "ai"
        ) {
            lower.to_ascii_uppercase()
        } else if lower
            .strip_suffix(['b', 'm', 'k'])
            .is_some_and(|value| value.chars().all(|character| character.is_ascii_digit()))
        {
            let (number, unit) = lower.split_at(lower.len() - 1);
            format!("{number}{}", unit.to_ascii_uppercase())
        } else {
            let mut characters = lower.chars();
            characters
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + characters.as_str())
                .unwrap_or_default()
        };
        pieces.push(piece);
    }
    if !numeric.is_empty() {
        pieces.push(numeric.join("."));
    }
    if pieces.is_empty() {
        name.trim().to_owned()
    } else {
        pieces.join(" ")
    }
}

fn split_model_name(value: &str) -> Vec<String> {
    value
        .split(['-', '_', '.', '/', ' '])
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_ascii_lowercase())
        .collect()
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, part| current.get(part))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Errors produced while discovering or resolving Model Serving endpoints.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    /// The endpoint cache failed.
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    /// Model retirement status could not be resolved.
    #[error(transparent)]
    Status(#[from] ModelStatusError),
    /// A Databricks API request failed.
    #[error(transparent)]
    Databricks(#[from] DatabricksClientError),
    /// A Databricks API response did not contain the expected endpoint data.
    #[error("invalid Databricks model response: {0}")]
    InvalidResponse(&'static str),
}
