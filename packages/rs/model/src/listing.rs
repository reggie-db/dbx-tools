//! OpenAI and Codex model-list envelopes built from a Databricks catalogue.

use std::{cmp::Ordering, collections::BTreeMap};

use serde_json::{json, Map, Value};

use crate::{
    capabilities::ModelCapabilities,
    classify::EMBEDDING_TASK,
    lookup_models,
    models::{
        parse_model_name, ModelClass, ModelFamily, ModelQuery, RankedModel, ServingEndpointSummary,
    },
    reasoning::ReasoningEffort,
    resolve::compare_model_preference,
};

const CODEX_BASE_INSTRUCTIONS: &str = "You are a coding agent. Follow the user's instructions and use the available tools to work in the current repository.";

/// Build an OpenAI-compatible or Codex-compatible model-list response.
pub fn models_payload(
    endpoints: &[ServingEndpointSummary],
    search: Option<&str>,
    extended: bool,
    codex: bool,
) -> Value {
    models_payload_with_capabilities(endpoints, search, extended, codex, None)
}

/// Build a model-list response enriched with discovered Codex capabilities.
pub fn models_payload_with_capabilities(
    endpoints: &[ServingEndpointSummary],
    search: Option<&str>,
    extended: bool,
    codex: bool,
    capabilities: Option<&ModelCapabilities>,
) -> Value {
    let mut listed = listed_models(endpoints, search);
    if search.is_none_or(|value| value.trim().is_empty()) {
        listed = rank_listed_models(listed, endpoints);
    }
    if codex {
        json!({
            "models": listed
                .iter()
                .filter_map(|model| codex_model(model, extended, capabilities))
                .enumerate()
                .map(|(index, mut model)| {
                    model.insert("priority".to_owned(), json!(index + 1));
                    Value::Object(model)
                })
                .collect::<Vec<_>>()
        })
    } else {
        json!({
            "object": "list",
            "data": listed
                .iter()
                .map(|model| Value::Object(openai_model(model, extended)))
                .collect::<Vec<_>>()
        })
    }
}

fn listed_models(endpoints: &[ServingEndpointSummary], search: Option<&str>) -> Vec<ListedModel> {
    let Some(search) = search.map(str::trim).filter(|search| !search.is_empty()) else {
        return endpoints
            .iter()
            .filter(|endpoint| !endpoint.status.deprecated)
            .cloned()
            .map(|endpoint| ListedModel {
                endpoint,
                score: None,
                model_class: None,
            })
            .collect();
    };
    lookup_models(
        endpoints,
        &ModelQuery {
            search: Some(search.to_owned()),
            ..Default::default()
        },
    )
    .into_iter()
    .map(ListedModel::from)
    .collect()
}

/// Order an unfiltered catalogue by capability tier, model family, and search preference.
fn rank_listed_models(
    mut models: Vec<ListedModel>,
    endpoints: &[ServingEndpointSummary],
) -> Vec<ListedModel> {
    let mut base = Vec::with_capacity(models.len());
    let candidates = lookup_models(endpoints, &ModelQuery::default())
        .into_iter()
        .chain(lookup_models(
            endpoints,
            &ModelQuery {
                model_class: Some(ModelClass::Embedding),
                ..Default::default()
            },
        ));
    for candidate in candidates {
        if let Some(index) = models
            .iter()
            .position(|model| model.endpoint.name == candidate.endpoint.name)
        {
            let mut model = models.remove(index);
            model.model_class = Some(candidate.model_class);
            base.push(model);
        }
    }
    base.extend(models);

    let mut chat_families: BTreeMap<&'static str, (bool, Vec<ListedModel>)> = BTreeMap::new();
    let mut embedding_families: BTreeMap<&'static str, (bool, Vec<ListedModel>)> = BTreeMap::new();
    let mut custom = Vec::new();
    for model in base {
        let Some(family) = databricks_model_family(&model.endpoint) else {
            custom.push(model);
            continue;
        };
        let families = if model.model_class == Some(ModelClass::Embedding)
            || model.endpoint.task.as_deref() == Some(EMBEDDING_TASK)
        {
            &mut embedding_families
        } else {
            &mut chat_families
        };
        families
            .entry(family.as_str())
            .or_insert_with(|| (family.is_versioned(), Vec::new()))
            .1
            .push(model);
    }

    let mut listed = Vec::with_capacity(
        custom.len()
            + chat_families
                .values()
                .map(|(_, models)| models.len())
                .sum::<usize>()
            + embedding_families
                .values()
                .map(|(_, models)| models.len())
                .sum::<usize>(),
    );
    append_ranked_families(&mut listed, chat_families);
    append_ranked_families(&mut listed, embedding_families);
    custom.sort_by(|left, right| {
        left.endpoint
            .name
            .to_ascii_lowercase()
            .cmp(&right.endpoint.name.to_ascii_lowercase())
            .then_with(|| left.endpoint.name.cmp(&right.endpoint.name))
    });
    listed.extend(custom);
    listed
}

/// Append alphabetically keyed families using the search comparator within each family.
fn append_ranked_families(
    listed: &mut Vec<ListedModel>,
    families: BTreeMap<&'static str, (bool, Vec<ListedModel>)>,
) {
    for (_, (versioned, mut models)) in families {
        models.sort_by(|left, right| compare_listed_preference(left, right, versioned));
        listed.extend(models);
    }
}

/// Return the recognized family for a Databricks foundation-model endpoint.
fn databricks_model_family(endpoint: &ServingEndpointSummary) -> Option<ModelFamily> {
    let foundation_model = endpoint.name.starts_with("databricks-")
        || endpoint
            .model_service_name
            .as_deref()
            .is_some_and(|name| name.starts_with("system.ai."));
    foundation_model
        .then(|| parse_model_name(&endpoint.name))
        .flatten()
        .map(|parsed| parsed.family)
}

/// Compare listed models without fuzzy distance while keeping non-chat members last.
fn compare_listed_preference(left: &ListedModel, right: &ListedModel, versioned: bool) -> Ordering {
    match (left.model_class, right.model_class) {
        (Some(ModelClass::Embedding), Some(ModelClass::Embedding)) | (None, None) => {
            Ordering::Equal
        }
        (Some(ModelClass::Embedding), _) | (None, Some(_)) => Ordering::Greater,
        (_, Some(ModelClass::Embedding)) | (Some(_), None) => Ordering::Less,
        (Some(left_class), Some(right_class)) => compare_model_preference(
            &left.endpoint,
            left_class,
            &right.endpoint,
            right_class,
            versioned,
        ),
    }
}

fn openai_model(model: &ListedModel, extended: bool) -> Map<String, Value> {
    let endpoint = &model.endpoint;
    let mut entry = Map::from_iter([
        ("id".to_owned(), json!(endpoint.name)),
        ("object".to_owned(), json!("model")),
        ("owned_by".to_owned(), json!("databricks")),
        (
            "name".to_owned(),
            json!(endpoint.display_name.as_ref().unwrap_or(&endpoint.name)),
        ),
    ]);
    if extended {
        extend_model(&mut entry, model);
    }
    entry
}

fn codex_model(
    model: &ListedModel,
    extended: bool,
    capabilities: Option<&ModelCapabilities>,
) -> Option<Map<String, Value>> {
    let endpoint = &model.endpoint;
    let codex_model = codex_model_name(endpoint)?;
    let image_input = capabilities.is_some_and(|value| value.supports_image_input(endpoint));
    let apply_patch = capabilities.is_some_and(|value| value.supports_apply_patch(endpoint));
    let web_search = capabilities.is_some_and(|value| value.supports_web_search(endpoint));
    let reasoning_levels = endpoint
        .reasoning_efforts
        .iter()
        .map(|effort| {
            json!({
                "effort": effort,
                "description": match effort {
                    ReasoningEffort::None => "Disable explicit reasoning",
                    ReasoningEffort::Minimal => "Use the smallest available reasoning budget",
                    ReasoningEffort::Low => "Use a low reasoning budget",
                    ReasoningEffort::Medium => "Use a medium reasoning budget",
                    ReasoningEffort::High => "Use a high reasoning budget",
                    ReasoningEffort::Xhigh => "Use an extra-high reasoning budget",
                    ReasoningEffort::Max => "Use the largest available reasoning budget",
                },
            })
        })
        .collect::<Vec<_>>();
    let mut entry = Map::from_iter([
        ("slug".to_owned(), json!(codex_model)),
        (
            "display_name".to_owned(),
            json!(endpoint.display_name.as_ref().unwrap_or(&endpoint.name)),
        ),
        (
            "description".to_owned(),
            json!(endpoint
                .description
                .as_deref()
                .unwrap_or("Databricks Model Serving endpoint")),
        ),
        (
            "base_instructions".to_owned(),
            json!(CODEX_BASE_INSTRUCTIONS),
        ),
        (
            "supported_reasoning_levels".to_owned(),
            json!(reasoning_levels),
        ),
        ("shell_type".to_owned(), json!("unified_exec")),
        ("visibility".to_owned(), json!("list")),
        ("supported_in_api".to_owned(), json!(true)),
        ("availability_nux".to_owned(), Value::Null),
        ("upgrade".to_owned(), Value::Null),
        ("support_verbosity".to_owned(), json!(false)),
        ("default_verbosity".to_owned(), Value::Null),
        (
            "apply_patch_tool_type".to_owned(),
            if apply_patch {
                json!("freeform")
            } else {
                Value::Null
            },
        ),
        (
            "truncation_policy".to_owned(),
            json!({"mode": "tokens", "limit": 128_000}),
        ),
        ("context_window".to_owned(), Value::Null),
        ("experimental_supported_tools".to_owned(), json!([])),
        (
            "input_modalities".to_owned(),
            if image_input {
                json!(["text", "image"])
            } else {
                json!(["text"])
            },
        ),
        ("web_search_tool_type".to_owned(), json!("text")),
        ("supports_search_tool".to_owned(), json!(web_search)),
        ("supports_image_detail_original".to_owned(), json!(false)),
    ]);
    if extended {
        extend_model(&mut entry, model);
    }
    Some(entry)
}

fn extend_model(entry: &mut Map<String, Value>, model: &ListedModel) {
    let endpoint = &model.endpoint;
    for (key, value) in [
        ("displayName", json!(endpoint.display_name)),
        ("task", json!(endpoint.task)),
        ("state", json!(endpoint.state)),
        ("description", json!(endpoint.description)),
        ("supportsTools", json!(endpoint.supports_tools)),
        ("profile", json!(endpoint.profile)),
        ("class", json!(model.model_class.or(endpoint.model_class))),
        ("serviceNames", json!(endpoint.service_names)),
        ("modelServiceName", json!(endpoint.model_service_name)),
        ("reasoningEfforts", json!(endpoint.reasoning_efforts)),
        ("status", json!(endpoint.status)),
        ("score", json!(model.score)),
    ] {
        if !value.is_null() {
            entry.insert(key.to_owned(), value);
        }
    }
}

/// Derive the Codex `system.ai` model name for a compatible Databricks endpoint.
pub fn codex_model_name(endpoint: &ServingEndpointSummary) -> Option<String> {
    let parsed = parse_model_name(&endpoint.name)?;
    if parsed.model.iter().any(|part| part == "embedding")
        || matches!(
            parsed.family,
            ModelFamily::Bge
                | ModelFamily::Claude
                | ModelFamily::Gemini
                | ModelFamily::Gte
                | ModelFamily::Inkling
        )
    {
        return None;
    }
    let model = endpoint.name.strip_prefix("databricks-")?;
    Some(format!("system.ai.{model}"))
}

struct ListedModel {
    endpoint: ServingEndpointSummary,
    score: Option<f64>,
    model_class: Option<crate::models::ModelClass>,
}

impl From<RankedModel> for ListedModel {
    fn from(model: RankedModel) -> Self {
        Self {
            endpoint: model.endpoint,
            score: model.score,
            model_class: Some(model.model_class),
        }
    }
}
