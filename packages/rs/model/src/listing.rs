//! OpenAI and Codex model-list envelopes built from a Databricks catalogue.

use serde_json::{json, Map, Value};

use crate::{
    lookup_models,
    models::{parse_model_name, ModelFamily, ModelQuery, RankedModel, ServingEndpointSummary},
};

const CODEX_BASE_INSTRUCTIONS: &str = "You are a coding agent. Follow the user's instructions and use the available tools to work in the current repository.";

pub fn models_payload(
    endpoints: &[ServingEndpointSummary],
    search: Option<&str>,
    extended: bool,
    codex: bool,
) -> Value {
    let listed = listed_models(endpoints, search);
    if codex {
        json!({
            "models": listed
                .iter()
                .filter_map(|model| codex_model(model, extended))
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

fn codex_model(model: &ListedModel, extended: bool) -> Option<Map<String, Value>> {
    let endpoint = &model.endpoint;
    let codex_model = codex_model_name(endpoint)?;
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
        ("supported_reasoning_levels".to_owned(), json!([])),
        ("shell_type".to_owned(), json!("shell_command")),
        ("visibility".to_owned(), json!("list")),
        ("supported_in_api".to_owned(), json!(true)),
        ("availability_nux".to_owned(), Value::Null),
        ("upgrade".to_owned(), Value::Null),
        ("support_verbosity".to_owned(), json!(false)),
        ("default_verbosity".to_owned(), Value::Null),
        ("apply_patch_tool_type".to_owned(), Value::Null),
        (
            "truncation_policy".to_owned(),
            json!({"mode": "tokens", "limit": 128_000}),
        ),
        ("context_window".to_owned(), Value::Null),
        ("experimental_supported_tools".to_owned(), json!([])),
        ("input_modalities".to_owned(), json!(["text"])),
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
        ("status", json!(endpoint.status)),
        ("score", json!(model.score)),
    ] {
        if !value.is_null() {
            entry.insert(key.to_owned(), value);
        }
    }
}

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
