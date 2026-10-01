//! Databricks model discovery, caching, classification, and fuzzy resolution.

#![deny(missing_docs)]
#![deny(rustdoc::broken_intra_doc_links)]

#[used]
static RELEASE_VERSION_LINK: fn() -> &'static str = dbx_tools_core::build_info::version;

pub mod capabilities;
pub mod classify;
pub mod client;
mod documentation;
pub mod limits;
pub mod listing;
pub mod model_status;
pub mod models;
pub mod reasoning;
pub mod resolve;

pub use capabilities::{
    parse_model_capabilities, refresh_generated_model_capabilities, ModelCapabilities,
    ModelCapabilitiesError, ModelCapabilitiesResolver, MODEL_CAPABILITIES_TTL,
    OPENAI_RESPONSES_MODELS_URL, WEB_SEARCH_MODELS_URL,
};
pub use classify::{
    classify_by_family, classify_endpoints, supports_tools_by_family, CHAT_TASK, EMBEDDING_TASK,
};
pub use client::{
    endpoints_from_response, normalize_serving_endpoints_json, EndpointNormalizationError,
    ModelClient, ModelError, DEFAULT_MODEL_CACHE_TTL,
};
pub use limits::{
    parse_model_rate_limits, refresh_generated_model_rate_limits, ModelRateLimitCatalogue,
    ModelRateLimits, ModelRateLimitsError, ModelRateLimitsResolver, MODEL_RATE_LIMITS_TTL,
    MODEL_RATE_LIMITS_URL,
};
pub use listing::{codex_model_name, models_payload, models_payload_with_capabilities};
pub use model_status::{
    parse_retired_models, refresh_generated_retired_models, status_from_names, ModelStatusError,
    ModelStatusResolver, RETIRED_MODELS_TTL, RETIRED_MODELS_URL,
};
pub use models::{
    is_responses_only, model_family, model_search_query, model_service_names, model_serving_api,
    parse_model_name, version_tuple, ModelClass, ModelFamily, ModelProfile, ModelQuery,
    ModelServingApi, ModelStatus, ParsedModelName, RankedModel, ResolvedModel,
    ServingEndpointSummary,
};
pub use reasoning::{
    chat_tool_reasoning_effort, reasoning_effort_names_by_family, reasoning_efforts_by_family,
    reasoning_efforts_for_names, ReasoningEffort,
};
pub use resolve::{
    lookup_models, rank_model_id, rank_models, same_family_fallbacks, search_serving_endpoints,
    DEFAULT_FUZZY_THRESHOLD,
};

uniffi::setup_scaffolding!();
