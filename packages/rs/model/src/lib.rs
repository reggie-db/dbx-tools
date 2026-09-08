//! Databricks model discovery, caching, classification, and fuzzy resolution.

pub mod classify;
pub mod client;
pub mod listing;
pub mod model_status;
pub mod models;
pub mod resolve;

pub use classify::{
    classify_by_family, classify_endpoints, supports_tools_by_family, CHAT_TASK, EMBEDDING_TASK,
};
pub use client::{endpoints_from_response, ModelClient, ModelError, DEFAULT_MODEL_CACHE_TTL};
pub use listing::{codex_model_name, models_payload};
pub use model_status::{
    parse_retired_models, status_from_names, ModelStatusError, ModelStatusResolver,
    RETIRED_MODELS_TTL, RETIRED_MODELS_URL,
};
pub use models::{
    model_search_query, model_service_names, parse_model_name, version_tuple, ModelClass,
    ModelFamily, ModelProfile, ModelQuery, ModelStatus, ParsedModelName, RankedModel,
    ResolvedModel, ServingEndpointSummary,
};
pub use resolve::{
    lookup_models, rank_model_id, search_serving_endpoints, DEFAULT_FUZZY_THRESHOLD,
};
