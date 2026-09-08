//! Live Databricks endpoint discovery with a file-backed TTL cache.

use std::{collections::BTreeMap, time::Duration};

use dbx_tools_core::{platform_cache_root, FileCache, FileCacheError};
use reqwest::header::AUTHORIZATION;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    classify::{classify_endpoints, supports_tools_by_family},
    model_status::{status_from_names, ModelStatusError, ModelStatusResolver},
    models::{model_search_query, model_service_names, ModelProfile, ServingEndpointSummary},
    resolve::{rank_model_id, DEFAULT_FUZZY_THRESHOLD},
};

pub const DEFAULT_MODEL_CACHE_TTL: Duration = Duration::from_secs(300);
const MODEL_CACHE_VERSION: u8 = 3;

#[derive(Clone)]
pub struct ModelClient {
    client: reqwest::Client,
    host: String,
    cache: FileCache,
    status: ModelStatusResolver,
}

impl ModelClient {
    pub fn new(host: impl Into<String>) -> Result<Self, ModelError> {
        Self::with_cache_ttl(host, DEFAULT_MODEL_CACHE_TTL)
    }

    pub fn with_cache_ttl(
        host: impl Into<String>,
        cache_ttl: Duration,
    ) -> Result<Self, ModelError> {
        assert!(!cache_ttl.is_zero(), "model cache TTL must be positive");
        let host = host.into().trim_end_matches('/').to_owned();
        let key = format!("{:x}", Sha256::digest(host.as_bytes()));
        let cache = FileCache::new(
            platform_cache_root()?
                .join("dbx-tools")
                .join("model")
                .join(format!("{key}.v{MODEL_CACHE_VERSION}.json")),
            cache_ttl,
        );
        Ok(Self {
            client: reqwest::Client::new(),
            host,
            cache,
            status: ModelStatusResolver::new()?,
        })
    }

    pub fn with_cache(host: impl Into<String>, cache: FileCache) -> Result<Self, ModelError> {
        Ok(Self::with_cache_and_status(
            host,
            cache,
            ModelStatusResolver::new()?,
        ))
    }

    pub fn with_cache_and_status(
        host: impl Into<String>,
        cache: FileCache,
        status: ModelStatusResolver,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            host: host.into().trim_end_matches('/').to_owned(),
            cache,
            status,
        }
    }

    pub async fn models(
        &self,
        authorization: &str,
        force: bool,
    ) -> Result<Vec<ServingEndpointSummary>, ModelError> {
        if force {
            self.cache
                .refresh(|| self.fetch_models(authorization))
                .await
        } else {
            self.cache
                .get_or_try_init(|| self.fetch_models(authorization))
                .await
        }
    }

    pub async fn resolve(
        &self,
        authorization: &str,
        requested: &str,
    ) -> Result<String, ModelError> {
        Ok(self
            .resolve_endpoint(authorization, requested)
            .await?
            .map(|endpoint| endpoint.name)
            .unwrap_or_else(|| requested.to_owned()))
    }

    pub async fn resolve_endpoint(
        &self,
        authorization: &str,
        requested: &str,
    ) -> Result<Option<ServingEndpointSummary>, ModelError> {
        let models = self.models(authorization, false).await?;
        let resolved = resolve_from_models(&models, requested);
        if resolved != requested || models.iter().any(|model| model.name == requested) {
            return Ok(models.into_iter().find(|model| model.name == resolved));
        }
        let refreshed = self.models(authorization, true).await?;
        let resolved = resolve_from_models(&refreshed, requested);
        Ok(refreshed.into_iter().find(|model| model.name == resolved))
    }

    async fn fetch_models(
        &self,
        authorization: &str,
    ) -> Result<Vec<ServingEndpointSummary>, ModelError> {
        let response = self
            .client
            .get(format!("{}/api/2.0/serving-endpoints", self.host))
            .header(AUTHORIZATION, authorization)
            .send()
            .await?;
        let status = response.status();
        let body = response.bytes().await?;
        if !status.is_success() {
            return Err(ModelError::Databricks {
                status: status.as_u16(),
                body: String::from_utf8_lossy(&body).into_owned(),
            });
        }
        let value: Value = serde_json::from_slice(&body)?;
        let retired = self.status.retired_model_names().await?;
        endpoints_from_response_with_retired(&value, &retired)
    }
}

fn resolve_from_models(models: &[ServingEndpointSummary], requested: &str) -> String {
    let search = if models.iter().any(|model| model.name == requested) {
        requested.to_owned()
    } else {
        model_search_query(requested).unwrap_or_else(|| requested.to_owned())
    };
    rank_model_id(models, &search, DEFAULT_FUZZY_THRESHOLD).model_id
}

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

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error(transparent)]
    Cache(#[from] FileCacheError),
    #[error(transparent)]
    Status(#[from] ModelStatusError),
    #[error("Databricks model discovery returned HTTP {status}: {body}")]
    Databricks { status: u16, body: String },
    #[error("invalid Databricks model response: {0}")]
    InvalidResponse(&'static str),
    #[error("model discovery request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("model discovery response was invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
}
