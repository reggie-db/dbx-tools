//! HTTP routes for model listing, generation, and embeddings.

use std::{
    net::SocketAddr,
    num::NonZeroUsize,
    time::{Duration, Instant},
};

use aide::axum::ApiRouter;
use axum::{
    body::{Body, Bytes},
    extract::{
        ConnectInfo, DefaultBodyLimit, FromRequest, FromRequestParts, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Json, Router,
};
use axum_typed_routing::{api_route, TypedApiRouter};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use dbx_tools_core::{
    AuthKind, DatabricksClient, DatabricksClientError, DatabricksProfileSummary, TargetKind,
};
use dbx_tools_model::{
    codex_model_name, is_responses_only, models_payload_with_capabilities, same_family_fallbacks,
    ModelCapabilities, ModelCapabilitiesResolver, ModelClass, ServingEndpointSummary,
};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::info;

use crate::{
    adapt::{adapt_request, adapt_response, select_request_target, upstream_path},
    adaptive::{AutoTransition, AutoTransitionKind},
    error::ProxyError,
    events::{
        HttpEventKind, HttpExchangeEvent, HttpRequestEvent, HttpResponseEvent, HttpStreamEvent,
        MetricWindowResolution, MetricWindowStreamEvent, ProxyFeeds, RateLimitStreamEvent,
        RequestHop, ResponseHop,
    },
    images::normalize_embedded_images,
    metrics::{MetricsRuntime, PeerAddr},
    protocol::{is_codex_originator, ClientWire, TargetWire},
    rate_limit::{
        rate_limit_details, server_retry_after, ModelFallbackPolicy, RateLimitDetails,
        RateLimitGate, RateLimitPolicy,
    },
    request_log::{ReasoningSetting, RequestLogContext, RequestLogMetadata},
    runtime::{RuntimeManager, RuntimeSelection},
    stream::{stream_response, StreamLogContext},
    throttle::{
        is_input_limit_message, response_token_usage, AutoActivation, RequestThrottle,
        ResponseTokenUsage, ThrottleAcquisition, ThrottleRejectionKind, TokenEstimate,
    },
};

#[cfg(test)]
use crate::throttle::ThrottleConfig;

const ORIGINATOR_HEADER: &str = "originator";
const USER_ID_HEADER: &str = "x-forwarded-user";
const USER_EMAIL_HEADER: &str = "x-forwarded-email";
const FALLBACK_PREFERRED_MODEL_HEADER: &str = "x-model-proxy-preferred-model";
const FALLBACK_RESOLVED_MODEL_HEADER: &str = "x-model-proxy-resolved-model";
const FALLBACK_STEP_HEADER: &str = "x-model-proxy-fallback-step";
const CONTROL_HEADER: &str = "x-model-proxy-control";
const GRAPHQL_PATH: &str = "/graphql";

#[derive(Clone)]
pub(crate) struct AppState {
    capabilities: ModelCapabilitiesResolver,
    runtime: RuntimeManager,
    target: TargetWire,
    image_resize_threshold_bytes: usize,
    stream_idle_timeout: Duration,
    model_fallback: ModelFallbackPolicy,
    rate_limits: RateLimitGate,
    metrics: MetricsRuntime,
    feeds: ProxyFeeds,
    controls_enabled: bool,
}

pub(crate) struct AppConfig {
    pub(crate) target: TargetWire,
    pub(crate) image_resize_threshold_bytes: usize,
    pub(crate) stream_idle_timeout: Duration,
    pub(crate) model_fallback: ModelFallbackPolicy,
    pub(crate) rate_limits: RateLimitPolicy,
    pub(crate) metrics: MetricsRuntime,
    pub(crate) feeds: ProxyFeeds,
    pub(crate) controls_enabled: bool,
}

impl AppState {
    pub(crate) fn new(
        capabilities: ModelCapabilitiesResolver,
        runtime: RuntimeManager,
        config: AppConfig,
    ) -> Self {
        let rate_limits = RateLimitGate::new(config.rate_limits);
        Self {
            capabilities,
            runtime,
            target: config.target,
            image_resize_threshold_bytes: config.image_resize_threshold_bytes,
            stream_idle_timeout: config.stream_idle_timeout,
            model_fallback: config.model_fallback,
            rate_limits,
            metrics: config.metrics,
            feeds: config.feeds,
            controls_enabled: config.controls_enabled,
        }
    }
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
struct ModelsQuery {
    /// Include dbx-tools capability metadata in each model record.
    #[serde(default)]
    extended: bool,
    /// Filter or fuzzy-rank the live model catalogue.
    search: Option<String>,
}

/// Logical rate-limit principal and immediate transport peer for one request.
#[derive(Debug)]
struct RequestCaller {
    request_id: u64,
    started: Instant,
    preferred_model: String,
    upstream_host: String,
    principal: String,
    peer: SocketAddr,
}

#[derive(Clone, Copy, Debug)]
struct RequestId {
    id: u64,
    started: Instant,
}

#[derive(Clone, Debug)]
struct ResolvedModel(String);

struct RequestHeaders(HeaderMap);

impl<S> FromRequestParts<S> for RequestHeaders
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(parts.headers.clone()))
    }
}

impl aide::OperationInput for RequestHeaders {}

struct ProxyRequest {
    request_id: u64,
    started: Instant,
    headers: HeaderMap,
    body: Bytes,
}

impl<S> FromRequest<S> for ProxyRequest
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let request_context = request.extensions().get::<RequestId>().copied();
        let request_id = request_context.map_or(0, |request| request.id);
        let started = request_context.map_or_else(Instant::now, |request| request.started);
        let headers = request.headers().clone();
        let body = Bytes::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        Ok(Self {
            request_id,
            started,
            headers,
            body,
        })
    }
}

impl aide::OperationInput for ProxyRequest {
    fn operation_input(
        ctx: &mut aide::generate::GenContext,
        operation: &mut aide::openapi::Operation,
    ) {
        <dbx_tools_service::openapi::FreeformJsonInput as aide::OperationInput>::operation_input(
            ctx, operation,
        );
    }
}

struct ProxyResponse(Response);

impl IntoResponse for ProxyResponse {
    fn into_response(self) -> Response {
        self.0
    }
}

impl aide::OperationOutput for ProxyResponse {
    type Inner = serde_json::Value;

    fn operation_response(
        ctx: &mut aide::generate::GenContext,
        operation: &mut aide::openapi::Operation,
    ) -> Option<aide::openapi::Response> {
        <dbx_tools_service::openapi::JsonOrEventStreamOutput as aide::OperationOutput>::operation_response(
            ctx, operation,
        )
    }

    fn inferred_responses(
        ctx: &mut aide::generate::GenContext,
        operation: &mut aide::openapi::Operation,
    ) -> Vec<(Option<u16>, aide::openapi::Response)> {
        <dbx_tools_service::openapi::JsonOrEventStreamOutput as aide::OperationOutput>::inferred_responses(
            ctx, operation,
        )
    }
}

struct UpstreamControls<'a> {
    client: &'a DatabricksClient,
    model_fallback: ModelFallbackPolicy,
    rate_limits: &'a RateLimitGate,
    throttle: &'a RequestThrottle,
    metrics: &'a MetricsRuntime,
}

#[derive(Clone, Debug)]
struct UpstreamRequest {
    model: String,
    model_class: Option<ModelClass>,
    estimate: TokenEstimate,
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
    target: Option<TargetWire>,
}

#[derive(Debug)]
struct UpstreamResult {
    candidate_index: usize,
    response: reqwest::Response,
    throttle: ThrottleAcquisition,
    upstream_attempt: u32,
    response_event_emitted: bool,
}

#[api_route(POST "/v1/chat/completions" with AppState)]
async fn chat_completions(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    ProxyRequest {
        request_id,
        started,
        headers,
        body,
    }: ProxyRequest,
) -> ProxyResponse {
    ProxyResponse(
        proxy(
            state,
            ClientWire::Chat,
            peer,
            request_id,
            started,
            headers,
            body,
        )
        .await
        .into_response(),
    )
}

#[api_route(POST "/v1/responses" with AppState)]
async fn responses(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    ProxyRequest {
        request_id,
        started,
        headers,
        body,
    }: ProxyRequest,
) -> ProxyResponse {
    ProxyResponse(
        proxy(
            state,
            ClientWire::Responses,
            peer,
            request_id,
            started,
            headers,
            body,
        )
        .await
        .into_response(),
    )
}

#[api_route(POST "/v1/messages" with AppState)]
async fn anthropic_messages(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    ProxyRequest {
        request_id,
        started,
        headers,
        body,
    }: ProxyRequest,
) -> ProxyResponse {
    ProxyResponse(
        proxy(
            state,
            ClientWire::Anthropic,
            peer,
            request_id,
            started,
            headers,
            body,
        )
        .await
        .into_response(),
    )
}

fn api_router(controls_enabled: bool) -> ApiRouter<AppState> {
    let mut router = ApiRouter::new()
        .typed_api_route(health)
        .typed_api_route(list_models)
        .typed_api_route(embeddings)
        .typed_api_route(chat_completions)
        .typed_api_route(responses)
        .typed_api_route(anthropic_messages);
    if controls_enabled {
        router = router
            .typed_api_route(auth_status)
            .typed_api_route(auth_profiles);
        let controls = ApiRouter::new()
            .typed_api_route(auth_switch)
            .typed_api_route(cancel_model_waits)
            .typed_api_route(retry_model_now)
            .layer(middleware::from_fn(require_control_request));
        router = router.merge(controls);
    }
    router
}

pub(crate) fn openapi() -> aide::openapi::OpenApi {
    dbx_tools_service::openapi::finish(
        api_router(true),
        "dbx-tools model proxy",
        env!("CARGO_PKG_VERSION"),
    )
    .document
    .as_ref()
    .clone()
}

pub(crate) async fn routes(
    state: AppState,
    max_request_bytes: NonZeroUsize,
) -> Result<Router, String> {
    let metrics = state.metrics.clone();
    let mut router = dbx_tools_service::openapi::finish(
        api_router(state.controls_enabled),
        "dbx-tools model proxy",
        env!("CARGO_PKG_VERSION"),
    )
    .router;
    if metrics.collection_enabled() && metrics.routes_visible() {
        let schema = dbx_tools_service::graphql::schema(
            MetricsQuery {
                state: state.clone(),
            },
            async_graphql::EmptyMutation,
            MetricsSubscription {
                state: state.clone(),
            },
        );
        let ui = graphql_ui();
        dbx_tools_service::graphql::validate_samples(&schema, &ui).await?;
        router = router.merge(dbx_tools_service::graphql::routes_with_ui(
            GRAPHQL_PATH,
            schema,
            ui,
        ));
    }
    router = router.layer(DefaultBodyLimit::max(max_request_bytes.get()));
    if metrics.collection_enabled() {
        router = router.layer(middleware::from_fn_with_state(
            state.clone(),
            track_active_request,
        ));
    }
    Ok(router.with_state(state))
}

async fn require_control_request(request: Request, next: Next) -> Response {
    if !control_request_allowed(request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": {
                    "type": "control_request_forbidden",
                    "message": "Model proxy controls require a same-origin loopback request and X-Model-Proxy-Control: 1."
                }
            })),
        )
            .into_response();
    }
    next.run(request).await
}

fn control_request_allowed(headers: &HeaderMap) -> bool {
    let control = headers
        .get(CONTROL_HEADER)
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    control == Some("1")
        && host.is_some_and(is_loopback_authority)
        && origin.zip(host).is_some_and(|(origin, host)| {
            origin == format!("http://{host}")
                && headers
                    .get("sec-fetch-site")
                    .and_then(|value| value.to_str().ok())
                    .is_none_or(|value| value == "same-origin")
        })
}

fn is_loopback_authority(authority: &str) -> bool {
    let host = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .or_else(|| authority.split(':').next())
        .unwrap_or(authority);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

async fn live_metrics_snapshot(state: &AppState) -> crate::metrics::MetricsSnapshot {
    let runtime = state.runtime.capture();
    let capacities = runtime.throttle.capacity_snapshots().await;
    let rate_limits = state.rate_limits.model_snapshots().await;
    let counters = runtime.throttle.counters().await;
    let gate_counters = state.rate_limits.control_counters();
    state.metrics.record_capacity_snapshots(&capacities);
    state
        .metrics
        .record_rate_limit_snapshots(&rate_limits, state.controls_enabled);
    let mut snapshot = state.metrics.snapshot();
    snapshot.apply_capacity_snapshots(&capacities);
    snapshot.apply_rate_limit_snapshots(&rate_limits, state.controls_enabled);
    snapshot.rate_limit_events = state
        .feeds
        .rate_limits
        .replay(None)
        .unwrap_or_default()
        .into_iter()
        .map(|event| event.payload)
        .collect();
    snapshot.rate_limits = crate::metrics::RateLimitHealthSnapshot {
        automatic_activations: counters.automatic_activations,
        automatic_tightenings: counters.automatic_tightenings,
        automatic_relaxations: counters.automatic_relaxations,
        automatic_deactivations: counters.automatic_deactivations,
        automatic_reactivations: counters.automatic_reactivations,
        auto_active_keys: counters.auto_active_keys,
        admission_waits: counters.admission_waits,
        capacity_wait_cancellations: counters.wait_cancellations,
        cooldown_wait_cancellations: gate_counters.wait_cancellations,
        cooldown_releases: gate_counters.cooldown_releases,
        oversized_rejections: counters.oversized_rejections,
        input_429_after_admission: counters.input_429_after_admission,
        retry_reacquisitions: counters.retry_reacquisitions,
        fallback_window_delays: counters.fallback_window_delays,
    };
    snapshot
}

#[derive(Clone)]
struct MetricsQuery {
    state: AppState,
}

#[async_graphql::Object]
impl MetricsQuery {
    /// Query the current bounded metrics snapshot.
    async fn snapshot(&self) -> crate::metrics::MetricsSnapshot {
        live_metrics_snapshot(&self.state).await
    }

    /// Query retained closed metric windows after an optional sequence cursor.
    async fn metric_window_history(
        &self,
        resolution: MetricWindowResolution,
        #[graphql(desc = "Return events with sequence greater than this cursor")]
        after_sequence: Option<u64>,
    ) -> Vec<MetricWindowStreamEvent> {
        let events = match resolution {
            MetricWindowResolution::FiveSeconds => {
                self.state.feeds.five_second_windows.replay(after_sequence)
            }
            MetricWindowResolution::OneMinute => {
                self.state.feeds.minute_windows.replay(after_sequence)
            }
        };
        events
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect()
    }

    /// Query retained rate-limit transitions after an optional sequence cursor.
    async fn rate_limit_history(
        &self,
        #[graphql(desc = "Return events with sequence greater than this cursor")]
        after_sequence: Option<u64>,
    ) -> Vec<RateLimitStreamEvent> {
        self.state
            .feeds
            .rate_limits
            .replay(after_sequence)
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect()
    }
}

#[derive(Clone)]
struct MetricsSubscription {
    state: AppState,
}

#[rustfmt::skip]
fn graphql_ui() -> dbx_tools_service::graphql::GraphqlUiConfig {
    use dbx_tools_service::graphql::{GraphqlSample, GraphqlUiConfig};

    GraphqlUiConfig::new("Model Proxy GraphQL")
        .sample(GraphqlSample::new(
            "Current metrics",
            // ============================================================================
            /*graphql*/r#"
query CurrentMetrics {
  snapshot {
    mode
    summary { requestsPerMinute p50LatencyMs p95LatencyMs p99LatencyMs }
    rateLimits { automaticActivations automaticTightenings retryReacquisitions }
  }
}
"#
            // ============================================================================
            ,
        ))
        .sample(GraphqlSample::new(
            "Model performance",
            // ============================================================================
            /*graphql*/r#"
query ModelPerformance {
  snapshot {
    models {
      model
      requests
      p50LatencyMs
      p95LatencyMs
      p99LatencyMs
      limiter
      penaltyBasisPoints
    }
  }
}
"#
            // ============================================================================
            ,
        ))
        .sample(GraphqlSample::new(
            "HTTP exchange",
            // ============================================================================
            /*graphql*/r#"
subscription HttpExchange {
  requests {
    sequence
    event {
      kind
      request {
        requestId hop elapsedMs attempt method host path bodyBytes
        clientProtocol targetProtocol preferredModel actualModel streaming fallbackStep
        headers { name values { value } }
        body { content }
      }
      response {
        requestId hop elapsedMs durationMs attempt method host path status responseBytes
        clientProtocol targetProtocol preferredModel actualModel streaming fallbackStep transportError
        headers { name values { value } }
        body { content }
        sse { event data id }
      }
    }
  }
}
"#
            // ============================================================================
            ,
        ))
        .sample(GraphqlSample::new(
            "Five-second windows",
            // ============================================================================
            /*graphql*/r#"
subscription MetricWindows {
  metricWindows(resolution: FIVE_SECONDS) {
    sequence
    event {
      bucket { requests p50LatencyMs p95LatencyMs p99LatencyMs rateLimited }
    }
  }
}
"#
            // ============================================================================
            ,
        ))
        .sample(GraphqlSample::new(
            "Rate-limit changes",
            // ============================================================================
            /*graphql*/r#"
subscription RateLimitChanges {
  rateLimitChanges {
    sequence
    event {
      model
      transition { kind penaltyBasisPoints effectiveInputBudget }
    }
  }
}
"#
            // ============================================================================
            ,
        ))
}

#[async_graphql::Subscription]
impl MetricsSubscription {
    /// Stream selected client and upstream request/response hops.
    async fn requests(
        &self,
        #[graphql(desc = "Include only these event kinds; omitted or empty includes all")]
        include: Option<Vec<HttpEventKind>>,
        #[graphql(desc = "Omit these event kinds")] exclude: Option<Vec<HttpEventKind>>,
        #[graphql(desc = "Include events matching any preferred or actual model")] models: Option<
            Vec<String>,
        >,
    ) -> impl Stream<Item = HttpStreamEvent> {
        let include = include.unwrap_or_default();
        let exclude = exclude.unwrap_or_default();
        let models = models.unwrap_or_default();
        self.state
            .feeds
            .http
            .subscribe(None)
            .filter_map(move |value| {
                let included = (include.is_empty() || include.contains(&value.payload.kind))
                    && !exclude.contains(&value.payload.kind)
                    && value.payload.model_matches(&models);
                futures_util::future::ready(included.then(|| value.into()))
            })
    }

    /// Stream closed aggregate windows with optional replay after a sequence.
    async fn metric_windows(
        &self,
        resolution: MetricWindowResolution,
        #[graphql(desc = "Replay events with sequence greater than this cursor")]
        after_sequence: Option<u64>,
    ) -> impl Stream<Item = MetricWindowStreamEvent> {
        match resolution {
            MetricWindowResolution::FiveSeconds => self
                .state
                .feeds
                .five_second_windows
                .subscribe(after_sequence),
            MetricWindowResolution::OneMinute => {
                self.state.feeds.minute_windows.subscribe(after_sequence)
            }
        }
        .map(Into::into)
    }

    /// Stream rate-limit transitions with optional replay after a sequence.
    async fn rate_limit_changes(
        &self,
        #[graphql(desc = "Replay events with sequence greater than this cursor")]
        after_sequence: Option<u64>,
    ) -> impl Stream<Item = RateLimitStreamEvent> {
        self.state
            .feeds
            .rate_limits
            .subscribe(after_sequence)
            .map(Into::into)
    }
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    /// Health state for the running proxy.
    status: String,
    /// Active immutable runtime generation.
    generation: u64,
}

#[api_route(GET "/api/healthz" with AppState)]
async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_owned(),
        generation: state.runtime.capture().id,
    })
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    /// Whether same-origin loopback control routes are enabled.
    controls_enabled: bool,
    /// Current secret-free Databricks runtime status.
    runtime: crate::runtime::RuntimeStatus,
}

#[api_route(GET "/api/auth" with AppState)]
async fn auth_status(State(state): State<AppState>) -> Json<AuthStatusResponse> {
    Json(AuthStatusResponse {
        controls_enabled: state.controls_enabled,
        runtime: state.runtime.status(),
    })
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
struct AuthProfilesQuery {
    /// Re-read the Databricks configuration file before listing profiles.
    #[serde(default)]
    refresh: bool,
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesResponse {
    /// Secret-free configured Databricks profiles.
    profiles: Vec<ProfileResponse>,
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResponse {
    /// Databricks CLI profile name.
    name: String,
    /// Configured workspace or accounts host.
    host: Option<String>,
    /// Account identifier associated with the profile.
    account_id: Option<String>,
    /// Workspace identifier associated with the profile.
    workspace_id: Option<String>,
    /// Target inferred from the configured host and account metadata.
    target: ProfileTarget,
    /// Authentication kind inferred without returning credential values.
    auth_kind: ProfileAuthKind,
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProfileTarget {
    Workspace,
    Account,
    Unified,
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProfileAuthKind {
    UserToMachine,
    MachineToMachine,
    PersonalAccessToken,
    AppServicePrincipal,
    AppOnBehalfOf,
}

#[api_route(GET "/api/auth/profiles" with AppState)]
async fn auth_profiles(
    State(state): State<AppState>,
    Query(query): Query<AuthProfilesQuery>,
) -> Result<Json<ProfilesResponse>, ControlApiError> {
    let profiles = state
        .runtime
        .profiles(query.refresh)
        .map_err(|error| ControlApiError::new(StatusCode::BAD_GATEWAY, error.to_string()))?;
    Ok(Json(ProfilesResponse {
        profiles: profiles.iter().map(profile_response).collect(),
    }))
}

fn profile_response(profile: &DatabricksProfileSummary) -> ProfileResponse {
    ProfileResponse {
        name: profile.name.clone(),
        host: profile.host.clone(),
        account_id: profile.account_id.clone(),
        workspace_id: profile.workspace_id.clone(),
        target: match profile.target {
            TargetKind::Workspace => ProfileTarget::Workspace,
            TargetKind::Account => ProfileTarget::Account,
            TargetKind::Unified => ProfileTarget::Unified,
        },
        auth_kind: match profile.auth_kind {
            AuthKind::UserToMachine => ProfileAuthKind::UserToMachine,
            AuthKind::MachineToMachine => ProfileAuthKind::MachineToMachine,
            AuthKind::PersonalAccessToken => ProfileAuthKind::PersonalAccessToken,
            AuthKind::AppServicePrincipal => ProfileAuthKind::AppServicePrincipal,
            AuthKind::AppOnBehalfOf => ProfileAuthKind::AppOnBehalfOf,
        },
    }
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSwitchResponse {
    /// Newly committed secret-free Databricks runtime status.
    runtime: crate::runtime::RuntimeStatus,
}

#[api_route(PUT "/api/auth" with AppState)]
async fn auth_switch(
    State(state): State<AppState>,
    Json(selection): Json<RuntimeSelection>,
) -> Result<Json<AuthSwitchResponse>, ControlApiError> {
    match state.runtime.switch(selection).await {
        Ok(status) => {
            let metrics = state.metrics.clone();
            let storage_key = status.storage_key.clone();
            match tokio::task::spawn_blocking(move || metrics.activate_runtime(storage_key)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(%error, "runtime switched but aggregate metrics restoration failed");
                }
                Err(error) => {
                    tracing::warn!(%error, "runtime switched but metrics restoration task failed");
                }
            }
            Ok(Json(AuthSwitchResponse { runtime: status }))
        }
        Err(error) => Err(ControlApiError::new(
            StatusCode::BAD_GATEWAY,
            error.to_string(),
        )),
    }
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelWaitsResponse {
    /// Resolved model whose waits were cancelled.
    model: String,
    /// Cancelled token-capacity waiters.
    capacity_waiters: u64,
    /// Cancelled cooldown waiters.
    cooldown_waiters: u64,
    /// Cooldown keys matched for the model.
    matched_cooldown_keys: u64,
    /// Total token-capacity and cooldown waiters cancelled.
    cancelled_waiters: u64,
}

#[api_route(POST "/api/rate-limits/models/{model}/cancel-waits" with AppState)]
async fn cancel_model_waits(
    model: String,
    State(state): State<AppState>,
) -> Result<Json<CancelWaitsResponse>, ControlApiError> {
    let model = model.trim();
    if model.is_empty() {
        return Err(ControlApiError::new(
            StatusCode::BAD_REQUEST,
            "model must not be empty",
        ));
    }
    let runtime = state.runtime.capture();
    let capacity = runtime.throttle.cancel_waits(model).await;
    let cooldown = state.rate_limits.cancel_waits(model).await;
    Ok(Json(CancelWaitsResponse {
        model: model.to_owned(),
        capacity_waiters: capacity.cancelled_waiters,
        cooldown_waiters: cooldown.cancelled_waiters,
        matched_cooldown_keys: cooldown.matched_keys,
        cancelled_waiters: capacity
            .cancelled_waiters
            .saturating_add(cooldown.cancelled_waiters),
    }))
}

#[derive(Debug, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryNowResponse {
    /// Resolved model whose cooldowns were released.
    model: String,
    /// Cooldown keys matched for the model.
    matched_cooldown_keys: u64,
    /// Active cooldowns released immediately.
    released_cooldowns: u64,
}

#[api_route(POST "/api/rate-limits/models/{model}/retry-now" with AppState)]
async fn retry_model_now(
    model: String,
    State(state): State<AppState>,
) -> Result<Json<RetryNowResponse>, ControlApiError> {
    let model = model.trim();
    if model.is_empty() {
        return Err(ControlApiError::new(
            StatusCode::BAD_REQUEST,
            "model must not be empty",
        ));
    }
    let released = state.rate_limits.release_cooldowns(model).await;
    Ok(Json(RetryNowResponse {
        model: model.to_owned(),
        matched_cooldown_keys: released.matched_keys,
        released_cooldowns: released.released_cooldowns,
    }))
}

#[derive(Debug)]
struct ControlApiError {
    status: StatusCode,
    message: String,
}

impl ControlApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ControlApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
            "error": {
                "type": "model_proxy_control_error",
                    "message": self.message
                }
            })),
        )
            .into_response()
    }
}

impl aide::OperationOutput for ControlApiError {
    type Inner = serde_json::Value;
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

async fn track_active_request(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let request_id = state.feeds.next_request_id();
    let started = Instant::now();
    request.extensions_mut().insert(RequestId {
        id: request_id,
        started,
    });
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let event_headers = state.feeds.headers(request.headers());
    let model_body_route = matches!(
        path.as_str(),
        "/v1/chat/completions" | "/v1/responses" | "/v1/messages" | "/v1/embeddings"
    );
    if state.feeds.http.is_active() {
        let (parts, body) = request.into_parts();
        let mut body = body.into_data_stream();
        let mut completion = ClientRequestCompletion {
            feeds: state.feeds.clone(),
            request_id,
            method: method.clone(),
            host: host.clone(),
            path: path.clone(),
            started,
            content_type,
            headers: event_headers,
            request_body: Vec::new(),
            publish_completion: !model_body_route,
        };
        let stream = async_stream::stream! {
            while let Some(chunk) = body.next().await {
                if let Ok(bytes) = &chunk {
                    completion.record_chunk(bytes);
                }
                yield chunk;
            }
        };
        request = Request::from_parts(parts, Body::from_stream(stream));
    }
    let track_active = !path.starts_with("/api/") && path != "/graphql";
    let _active_request = track_active.then(|| {
        state.metrics.request_started();
        ActiveRequestGuard(state.metrics.clone())
    });
    let response = next.run(request).await;
    if !state.feeds.http.is_active() {
        return response;
    }
    let (parts, body) = response.into_parts();
    let status = parts.status;
    let resolved_model = parts
        .extensions
        .get::<ResolvedModel>()
        .map(|model| model.0.clone());
    let content_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let event_headers = state.feeds.headers(&parts.headers);
    if content_type
        .as_deref()
        .is_some_and(|content_type| content_type.starts_with("text/event-stream"))
    {
        let _ = state
            .feeds
            .http
            .publish(HttpExchangeEvent::from_response(HttpResponseEvent {
                request_id,
                hop: ResponseHop::ProxyToClient,
                elapsed_ms: elapsed_ms(started),
                duration_ms: None,
                attempt: None,
                method: method.clone(),
                host: host.clone(),
                path: path.clone(),
                status: Some(status.as_u16()),
                headers: Some(event_headers),
                response_bytes: None,
                client_protocol: None,
                target_protocol: None,
                preferred_model: None,
                actual_model: resolved_model.clone(),
                streaming: None,
                fallback_step: None,
                transport_error: None,
                body: None,
                sse: None,
            }));
        return Response::from_parts(parts, body);
    }
    let mut completion = ClientResponseCompletion {
        feeds: state.feeds,
        request_id,
        method,
        host,
        path,
        status,
        started,
        content_type,
        headers: event_headers,
        response_body: Vec::new(),
        resolved_model,
    };
    let mut body = body.into_data_stream();
    let stream = async_stream::stream! {
        while let Some(chunk) = body.next().await {
            if let Ok(bytes) = &chunk {
                completion.record_chunk(bytes);
            }
            yield chunk;
        }
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

struct ActiveRequestGuard(MetricsRuntime);

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.0.request_finished();
    }
}

struct ClientRequestCompletion {
    feeds: ProxyFeeds,
    request_id: u64,
    method: String,
    host: Option<String>,
    path: String,
    started: Instant,
    content_type: Option<String>,
    headers: Vec<crate::events::HttpHeader>,
    request_body: Vec<u8>,
    publish_completion: bool,
}

impl ClientRequestCompletion {
    fn record_chunk(&mut self, bytes: &[u8]) {
        self.request_body.extend_from_slice(bytes);
    }
}

impl Drop for ClientRequestCompletion {
    fn drop(&mut self) {
        if !self.publish_completion {
            return;
        }
        let body = self
            .feeds
            .request_body(&self.request_body, self.content_type.as_deref(), 0);
        let _ = self
            .feeds
            .http
            .publish(HttpExchangeEvent::from_request(HttpRequestEvent {
                request_id: self.request_id,
                hop: RequestHop::ClientToProxy,
                elapsed_ms: elapsed_ms(self.started),
                attempt: None,
                method: self.method.clone(),
                host: self.host.clone(),
                path: self.path.clone(),
                headers: Some(self.headers.clone()),
                body_bytes: Some(self.request_body.len() as u64),
                client_protocol: None,
                target_protocol: None,
                preferred_model: None,
                actual_model: None,
                streaming: None,
                fallback_step: None,
                body,
            }));
    }
}

struct ClientResponseCompletion {
    feeds: ProxyFeeds,
    request_id: u64,
    method: String,
    host: Option<String>,
    path: String,
    status: StatusCode,
    started: Instant,
    content_type: Option<String>,
    headers: Vec<crate::events::HttpHeader>,
    response_body: Vec<u8>,
    resolved_model: Option<String>,
}

impl ClientResponseCompletion {
    fn record_chunk(&mut self, bytes: &[u8]) {
        self.response_body.extend_from_slice(bytes);
    }
}

impl Drop for ClientResponseCompletion {
    fn drop(&mut self) {
        let body = self.feeds.response_body(
            &self.response_body,
            self.response_body.len(),
            self.content_type.as_deref(),
            Some(0),
        );
        let _ = self
            .feeds
            .http
            .publish(HttpExchangeEvent::from_response(HttpResponseEvent {
                request_id: self.request_id,
                hop: ResponseHop::ProxyToClient,
                elapsed_ms: elapsed_ms(self.started),
                duration_ms: Some(elapsed_ms(self.started)),
                attempt: None,
                method: self.method.clone(),
                host: self.host.clone(),
                path: self.path.clone(),
                status: Some(self.status.as_u16()),
                headers: Some(self.headers.clone()),
                response_bytes: Some(self.response_body.len() as u64),
                client_protocol: None,
                target_protocol: None,
                preferred_model: None,
                actual_model: self.resolved_model.clone(),
                streaming: None,
                fallback_step: None,
                transport_error: None,
                body,
                sse: None,
            }));
    }
}

#[api_route(GET "/v1/models" with AppState)]
async fn list_models(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
    RequestHeaders(headers): RequestHeaders,
) -> Result<Json<Value>, ProxyError> {
    let runtime = state.runtime.capture();
    let started = Instant::now();
    let originator = request_originator(&headers);
    let codex = originator.is_some_and(is_codex_originator);
    let endpoints = runtime.models.list_serving_endpoints(false).await?;
    let capabilities = if codex {
        match state.capabilities.capabilities().await {
            Ok(capabilities) => Some(capabilities),
            Err(error) => {
                tracing::warn!(%error, "Codex capability discovery unavailable");
                None
            }
        }
    } else {
        None
    };
    let payload = models_payload_with_capabilities(
        &endpoints,
        query.search.as_deref(),
        query.extended,
        codex,
        capabilities.as_ref(),
    );
    let count = payload
        .get(if codex { "models" } else { "data" })
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    info!(
        route = "/v1/models",
        status = StatusCode::OK.as_u16(),
        duration_ms = started.elapsed().as_millis(),
        "model request completed"
    );
    tracing::debug!(
        route = "/v1/models",
        format = if codex { "codex" } else { "openai" },
        search = query.search.as_deref().unwrap_or_default(),
        extended = query.extended,
        models = count,
        client_ip = %peer.ip(),
        client_port = peer.port(),
        duration_ms = started.elapsed().as_millis(),
        "model request details"
    );
    Ok(Json(payload))
}

#[api_route(POST "/v1/embeddings" with AppState)]
async fn embeddings(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    ProxyRequest {
        request_id,
        started,
        headers,
        body,
    }: ProxyRequest,
) -> Result<ProxyResponse, ProxyError> {
    let runtime = state.runtime.capture();
    let request_bytes = body.len();
    let input: Value = serde_json::from_slice(&body)?;
    let requested_model = requested_model(&input)?.to_owned();
    if state.feeds.http.is_active() {
        let _ = state
            .feeds
            .http
            .publish(HttpExchangeEvent::from_request(HttpRequestEvent {
                request_id,
                hop: RequestHop::ClientToProxy,
                elapsed_ms: elapsed_ms(started),
                attempt: None,
                method: Method::POST.to_string(),
                host: headers
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned),
                path: "/v1/embeddings".to_owned(),
                headers: Some(state.feeds.headers(&headers)),
                body_bytes: Some(request_bytes as u64),
                client_protocol: Some("embeddings".to_owned()),
                target_protocol: None,
                preferred_model: Some(requested_model.clone()),
                actual_model: None,
                streaming: Some(false),
                fallback_step: None,
                body: state.feeds.request_body(
                    &body,
                    headers
                        .get(header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok()),
                    0,
                ),
            }));
    }
    let endpoint = runtime
        .models
        .resolve_serving_endpoint_for_class(&requested_model, ModelClass::Embedding)
        .await?
        .ok_or_else(|| ProxyError::EmbeddingModelNotFound(requested_model.clone()))?;
    let estimate = runtime.throttle.estimate(&endpoint.name, &input);
    let caller = request_caller(
        &headers,
        &runtime.databricks,
        peer,
        request_id,
        started,
        &requested_model,
    );
    let (path, request_body) = prepare_embedding_request(input, &endpoint.name)?;
    let event_path = path.clone();
    let originator = request_originator(&headers);
    let upstream = send_upstream(
        UpstreamControls {
            client: &runtime.databricks,
            model_fallback: ModelFallbackPolicy {
                mode: crate::rate_limit::ModelFallbackMode::Off,
                ..state.model_fallback
            },
            rate_limits: &state.rate_limits,
            throttle: &runtime.throttle,
            metrics: &state.metrics,
        },
        &caller,
        &[UpstreamRequest {
            model: endpoint.name.clone(),
            model_class: endpoint.model_class,
            estimate,
            path,
            headers: upstream_headers(originator),
            body: request_body,
            target: None,
        }],
    )
    .await?;
    let UpstreamResult {
        candidate_index: _,
        response,
        throttle,
        upstream_attempt,
        response_event_emitted,
    } = upstream;
    let upstream = buffered_response(response).await?;
    if !response_event_emitted {
        publish_buffered_upstream_body(
            &state.feeds,
            &caller,
            &endpoint.name,
            &event_path,
            None,
            upstream_attempt,
            0,
            &upstream,
        );
    }
    let usage = response_usage(&upstream.body);
    RequestLogContext::new(
        RequestLogMetadata {
            runtime_key: runtime.storage_key.clone(),
            requested_model,
            resolved_model: endpoint.name.clone(),
            peer: caller.peer,
            request_bytes,
            started,
            reasoning_setting: None,
            fallback_step: 0,
        },
        throttle,
        upstream_attempt,
        state.metrics.clone(),
    )
    .complete_embedding(upstream.status, usage)
    .await;
    let mut response = upstream.into_raw_response();
    response
        .extensions_mut()
        .insert(ResolvedModel(endpoint.name));
    Ok(ProxyResponse(response))
}

async fn proxy(
    state: AppState,
    client_wire: ClientWire,
    peer: SocketAddr,
    request_id: u64,
    started: Instant,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let runtime = state.runtime.capture();
    let request_bytes = body.len();
    let mut input: Value = serde_json::from_slice(&body)?;
    normalize_embedded_images(&mut input, state.image_resize_threshold_bytes)?;
    let requested_model = requested_model(&input)?.to_owned();
    let reasoning_setting = ReasoningSetting::from_request(&input);
    let streaming = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if state.feeds.http.is_active() {
        let _ = state
            .feeds
            .http
            .publish(HttpExchangeEvent::from_request(HttpRequestEvent {
                request_id,
                hop: RequestHop::ClientToProxy,
                elapsed_ms: elapsed_ms(started),
                attempt: None,
                method: Method::POST.to_string(),
                host: headers
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned),
                path: match client_wire {
                    ClientWire::Chat => "/v1/chat/completions",
                    ClientWire::Responses => "/v1/responses",
                    ClientWire::Anthropic => "/v1/messages",
                }
                .to_owned(),
                headers: Some(state.feeds.headers(&headers)),
                body_bytes: Some(request_bytes as u64),
                client_protocol: Some(client_wire.label().to_owned()),
                target_protocol: None,
                preferred_model: Some(requested_model.clone()),
                actual_model: None,
                streaming: Some(streaming),
                fallback_step: None,
                body: state.feeds.request_body(
                    &body,
                    headers
                        .get(header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok()),
                    0,
                ),
            }));
    }
    let originator = request_originator(&headers);
    let caller = request_caller(
        &headers,
        &runtime.databricks,
        peer,
        request_id,
        started,
        &requested_model,
    );
    let codex = originator.is_some_and(is_codex_originator);
    let endpoint = runtime
        .models
        .resolve_serving_endpoint(&requested_model)
        .await?;
    let capabilities = match state.capabilities.capabilities().await {
        Ok(capabilities) => Some(capabilities),
        Err(error) => {
            tracing::warn!(%error, "model capability discovery unavailable");
            None
        }
    };
    let mut endpoint_candidates = endpoint.iter().cloned().collect::<Vec<_>>();
    if state.model_fallback.enabled() && state.rate_limits.policy().max_retries > 0 {
        if let Some(endpoint) = endpoint.as_ref() {
            let endpoints = runtime.models.list_serving_endpoints(false).await?;
            endpoint_candidates.extend(same_family_fallbacks(
                &endpoints,
                endpoint,
                state.model_fallback.max_steps,
            ));
        }
    }
    let mut candidates = Vec::new();
    if endpoint_candidates.is_empty() {
        candidates.push(prepare_upstream_request(
            &runtime.throttle,
            client_wire,
            state.target,
            originator,
            codex,
            &input,
            &requested_model,
            None,
            capabilities.as_ref(),
        )?);
    } else {
        for (index, candidate) in endpoint_candidates.iter().enumerate() {
            if index > 0
                && !fallback_compatible(
                    client_wire,
                    state.target,
                    originator,
                    codex,
                    &input,
                    reasoning_setting,
                    candidate,
                    capabilities.as_ref(),
                )
            {
                continue;
            }
            let prepared = prepare_upstream_request(
                &runtime.throttle,
                client_wire,
                state.target,
                originator,
                codex,
                &input,
                &candidate.name,
                Some(candidate),
                capabilities.as_ref(),
            );
            match prepared {
                Ok(prepared) => candidates.push(prepared),
                Err(error) if index > 0 => tracing::debug!(
                    model = candidate.name,
                    %error,
                    "same-family model fallback candidate is incompatible"
                ),
                Err(error) => return Err(error),
            }
        }
    }
    let preferred_model = candidates
        .first()
        .expect("primary upstream candidate")
        .model
        .clone();
    let upstream = send_upstream(
        UpstreamControls {
            client: &runtime.databricks,
            model_fallback: state.model_fallback,
            rate_limits: &state.rate_limits,
            throttle: &runtime.throttle,
            metrics: &state.metrics,
        },
        &caller,
        &candidates,
    )
    .await?;
    let UpstreamResult {
        candidate_index,
        response: mut upstream,
        throttle,
        upstream_attempt,
        response_event_emitted,
    } = upstream;
    let candidate = &candidates[candidate_index];
    let model = candidate.model.clone();
    let target = candidate.target.expect("model candidate target");
    if candidate_index > 0 {
        add_fallback_headers(
            upstream.headers_mut(),
            &preferred_model,
            &model,
            candidate_index,
        );
    }
    let request_log = RequestLogContext::new(
        RequestLogMetadata {
            runtime_key: runtime.storage_key.clone(),
            requested_model,
            resolved_model: model.clone(),
            peer: caller.peer,
            request_bytes,
            started,
            reasoning_setting: Some(reasoning_setting),
            fallback_step: candidate_index,
        },
        throttle,
        upstream_attempt,
        state.metrics.clone(),
    );
    let status = upstream_status(&upstream)?;
    if status.is_success() && streaming {
        let response_headers = forwarded_response_headers(upstream.headers());
        let event_response_headers = state.feeds.headers(upstream.headers());
        request_log.stream_connected(client_wire, target, status);
        let mut response = stream_response(
            client_wire,
            target,
            upstream,
            model.clone(),
            response_headers,
            state.stream_idle_timeout,
            StreamLogContext {
                client_wire,
                target,
                request: request_log,
                feeds: state.feeds.clone(),
                upstream_event: HttpResponseEvent {
                    request_id: caller.request_id,
                    hop: ResponseHop::UpstreamToProxy,
                    elapsed_ms: elapsed_ms(caller.started),
                    duration_ms: None,
                    attempt: Some(upstream_attempt),
                    method: Method::POST.to_string(),
                    host: Some(caller.upstream_host.clone()),
                    path: candidate.path.clone(),
                    status: Some(status.as_u16()),
                    headers: Some(event_response_headers),
                    response_bytes: None,
                    client_protocol: None,
                    target_protocol: Some(target.label().to_owned()),
                    preferred_model: Some(caller.preferred_model.clone()),
                    actual_model: Some(model.clone()),
                    streaming: Some(true),
                    fallback_step: Some(u32::try_from(candidate_index).unwrap_or(u32::MAX)),
                    transport_error: None,
                    body: None,
                    sse: None,
                },
                _runtime: runtime,
            },
        )?;
        response
            .extensions_mut()
            .insert(ResolvedModel(model.clone()));
        return Ok(response);
    }
    let upstream = buffered_response(upstream).await?;
    if !response_event_emitted {
        publish_buffered_upstream_body(
            &state.feeds,
            &caller,
            &model,
            &candidate.path,
            Some(target),
            upstream_attempt,
            candidate_index,
            &upstream,
        );
    }
    if !upstream.status.is_success() {
        request_log
            .complete_model(
                client_wire,
                target,
                streaming,
                upstream.status,
                ResponseTokenUsage::default(),
            )
            .await;
        let mut response = upstream.into_raw_response();
        response
            .extensions_mut()
            .insert(ResolvedModel(model.clone()));
        return Ok(response);
    }

    let output = adapt_response(client_wire, target, upstream.status, &upstream.body)?;
    let usage = response_usage(&output);
    request_log
        .complete_model(client_wire, target, streaming, upstream.status, usage)
        .await;
    let mut response = upstream.into_json_response(output);
    response.extensions_mut().insert(ResolvedModel(model));
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn prepare_upstream_request(
    throttle: &RequestThrottle,
    client_wire: ClientWire,
    configured_target: TargetWire,
    originator: Option<&str>,
    codex: bool,
    original_input: &Value,
    model: &str,
    endpoint: Option<&ServingEndpointSummary>,
    capabilities: Option<&ModelCapabilities>,
) -> Result<UpstreamRequest, ProxyError> {
    let native_responses = endpoint.map_or_else(
        || is_responses_only(model),
        |endpoint| {
            is_responses_only(&endpoint.name)
                || capabilities.is_some_and(|value| value.supports_responses(endpoint))
        },
    );
    let mut input = original_input.clone();
    let upstream_model = if codex {
        endpoint
            .and_then(codex_model_name)
            .unwrap_or_else(|| model.to_owned())
    } else {
        model.to_owned()
    };
    input["model"] = Value::String(upstream_model);
    let estimate = throttle.estimate(model, &input);
    let target = select_request_target(
        configured_target,
        client_wire,
        originator,
        &input,
        native_responses,
    );
    Ok(UpstreamRequest {
        model: model.to_owned(),
        model_class: endpoint.and_then(|value| value.model_class),
        estimate,
        path: upstream_path(target, codex, native_responses).to_owned(),
        headers: upstream_headers(originator),
        body: adapt_request(client_wire, target, input)?,
        target: Some(target),
    })
}

#[allow(clippy::too_many_arguments)]
fn fallback_compatible(
    client_wire: ClientWire,
    configured_target: TargetWire,
    originator: Option<&str>,
    codex: bool,
    input: &Value,
    reasoning_setting: ReasoningSetting,
    endpoint: &ServingEndpointSummary,
    capabilities: Option<&ModelCapabilities>,
) -> bool {
    if endpoint.model_class == Some(ModelClass::Embedding)
        || (codex && codex_model_name(endpoint).is_none())
    {
        return false;
    }
    let supports_responses = is_responses_only(&endpoint.name)
        || capabilities.is_some_and(|value| value.supports_responses(endpoint));
    let tools = input
        .get("tools")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if tools.iter().any(|tool| {
        tool.get("type")
            .and_then(Value::as_str)
            .unwrap_or("function")
            == "function"
    }) && endpoint.supports_tools != Some(true)
    {
        return false;
    }
    for tool in tools {
        let kind = tool
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("function");
        let supported = match kind {
            "function" => endpoint.supports_tools == Some(true),
            kind if kind.starts_with("web_search") => {
                capabilities.is_some_and(|value| value.supports_web_search(endpoint))
            }
            "apply_patch" => capabilities.is_some_and(|value| value.supports_apply_patch(endpoint)),
            "custom" | "shell" | "local_shell" if codex => supports_responses,
            _ => false,
        };
        if !supported {
            return false;
        }
    }
    if request_contains_image(input)
        && !capabilities.is_some_and(|value| value.supports_image_input(endpoint))
    {
        return false;
    }
    match reasoning_setting {
        ReasoningSetting::Effort(effort) if !endpoint.reasoning_efforts.contains(&effort) => {
            return false;
        }
        ReasoningSetting::Adaptive | ReasoningSetting::Enabled
            if endpoint.reasoning_efforts.is_empty() =>
        {
            return false;
        }
        _ => {}
    }
    let mut candidate_input = input.clone();
    candidate_input["model"] = Value::String(endpoint.name.clone());
    let target = select_request_target(
        configured_target,
        client_wire,
        originator,
        &candidate_input,
        supports_responses,
    );
    target != TargetWire::Responses || supports_responses
}

fn request_contains_image(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(request_contains_image),
        Value::Object(values) => values.iter().any(|(key, value)| {
            matches!(key.as_str(), "image_url" | "input_image")
                || (key == "type" && value.as_str().is_some_and(|kind| kind.contains("image")))
                || request_contains_image(value)
        }),
        _ => false,
    }
}

fn add_fallback_headers(
    headers: &mut HeaderMap,
    preferred_model: &str,
    resolved_model: &str,
    step: usize,
) {
    for (name, value) in [
        (FALLBACK_PREFERRED_MODEL_HEADER, preferred_model.to_owned()),
        (FALLBACK_RESOLVED_MODEL_HEADER, resolved_model.to_owned()),
        (FALLBACK_STEP_HEADER, step.to_string()),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
}

fn response_usage(body: &[u8]) -> ResponseTokenUsage {
    serde_json::from_slice::<Value>(body)
        .map(|output| response_token_usage(&output))
        .unwrap_or_default()
}

async fn send_upstream(
    controls: UpstreamControls<'_>,
    caller: &RequestCaller,
    requests: &[UpstreamRequest],
) -> Result<UpstreamResult, ProxyError> {
    let UpstreamControls {
        client,
        model_fallback,
        rate_limits,
        throttle,
        metrics,
    } = controls;
    assert!(
        !requests.is_empty(),
        "upstream candidate list must not be empty"
    );
    let policy = rate_limits.policy();
    let deadline = tokio::time::Instant::now() + policy.max_wait;
    let mut backoff = policy.backoff();
    let mut last_rate_limit = None;
    let mut retries = 0;
    loop {
        let upstream_attempt = retries + 1;
        let mut preferred_indices = Vec::with_capacity(requests.len());
        for (index, request) in requests.iter().enumerate() {
            let long_local_wait = if model_fallback.enabled() && index + 1 < requests.len() {
                throttle
                    .token_window_delay(&request.model, request.model_class, request.estimate)
                    .await
                    .is_some_and(|delay| delay > model_fallback.threshold)
            } else {
                false
            };
            if !long_local_wait {
                preferred_indices.push(index);
            }
        }
        let (candidate_index, permit) = if policy.max_retries == 0 {
            (0, None)
        } else {
            let models = preferred_indices
                .iter()
                .map(|index| requests[*index].model.as_str())
                .collect::<Vec<_>>();
            let (preferred_index, permit) = match tokio::time::timeout_at(
                deadline,
                rate_limits.acquire_preferred_cancellable(
                    client.host(),
                    &caller.principal,
                    &models,
                ),
            )
            .await
            {
                Ok(Ok(acquired)) => acquired,
                Ok(Err(cancelled)) => {
                    metrics.record_local_rate_limit(&cancelled.model, "operator-cancelled");
                    if let Some(last_rate_limit) = last_rate_limit {
                        return Ok(last_rate_limit);
                    }
                    return Err(ProxyError::RateLimitWaitCancelled {
                        model: cancelled.model,
                    });
                }
                Err(_) => {
                    metrics.record_retry("wait-budget", true);
                    if last_rate_limit.is_none() {
                        metrics.record_local_rate_limit(&requests[0].model, "wait-budget");
                    }
                    tracing::warn!(
                        host = client.host(),
                        model = requests[0].model,
                        max_wait_ms = policy.max_wait.as_millis(),
                        "rate-limit wait budget exhausted"
                    );
                    return rate_limit_wait_exhausted(
                        last_rate_limit,
                        &requests[0].model,
                        policy.max_wait,
                    );
                }
            };
            (preferred_indices[preferred_index], Some(permit))
        };
        let request = &requests[candidate_index];
        let admission = match tokio::time::timeout_at(
            deadline,
            throttle.acquire(&request.model, request.model_class, request.estimate),
        )
        .await
        {
            Err(_) => {
                if let Some(permit) = permit.as_ref() {
                    rate_limits.cancelled(permit).await;
                }
                metrics.record_retry("wait-budget", true);
                if last_rate_limit.is_none() {
                    metrics.record_local_rate_limit(&request.model, "wait-budget");
                }
                tracing::warn!(
                    host = client.host(),
                    model = request.model,
                    max_wait_ms = policy.max_wait.as_millis(),
                    "token admission wait budget exhausted"
                );
                return rate_limit_wait_exhausted(last_rate_limit, &request.model, policy.max_wait);
            }
            Ok(result) => match result {
                Ok(admission) => admission,
                Err(error) => {
                    if let Some(permit) = permit.as_ref() {
                        rate_limits.cancelled(permit).await;
                    }
                    if error.kind == ThrottleRejectionKind::WaitCancelled {
                        metrics.record_local_rate_limit(&request.model, "operator-cancelled");
                        if let Some(last_rate_limit) = last_rate_limit {
                            return Ok(last_rate_limit);
                        }
                        return Err(ProxyError::RateLimitWaitCancelled {
                            model: request.model.clone(),
                        });
                    }
                    metrics.record_oversized(&request.model);
                    tracing::warn!(
                        host = client.host(),
                        model = request.model,
                        estimated_input_tokens = error.estimated_input_tokens,
                        token_limit_input = error.input_limit,
                        token_window_used_before = error.input_window_used_before,
                        token_throttle_mode = ?error.mode,
                        token_throttle_active = true,
                        upstream_attempt,
                        oversized_request = true,
                        "model request rejected by local input-token budget"
                    );
                    return Err(ProxyError::OversizedInput {
                        model: request.model.clone(),
                        estimated_input_tokens: error.estimated_input_tokens,
                        input_limit: error.input_limit,
                    });
                }
            },
        };
        if retries > 0 && admission.active {
            throttle.record_retry_reacquisition();
        }
        let attempt_started = Instant::now();
        if let Some(feeds) = metrics.feeds().filter(|feeds| feeds.http.is_active()) {
            let _ = feeds.http.publish(upstream_request_event(
                &feeds,
                caller,
                request,
                upstream_attempt,
                candidate_index,
            ));
        }
        let response = match client
            .request_builder(&request.path, Method::POST)?
            .headers(request.headers.clone())
            .body(request.body.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if let Some(feeds) = metrics.feeds().filter(|feeds| feeds.http.is_active()) {
                    let _ = feeds.http.publish(upstream_response_event(
                        &feeds,
                        caller,
                        request,
                        upstream_attempt,
                        None,
                        Some(attempt_started.elapsed()),
                        Some(error.to_string()),
                        candidate_index,
                        None,
                        None,
                    ));
                }
                admission.release().await;
                if let Some(permit) = permit.as_ref() {
                    rate_limits.completed(permit).await;
                }
                metrics.record_transport_failure(&request.model);
                tracing::warn!(
                    host = client.host(),
                    model = request.model,
                    upstream_attempt,
                    %error,
                    "model request transport failed"
                );
                return Err(DatabricksClientError::from(error).into());
            }
        };
        if response.status() != StatusCode::TOO_MANY_REQUESTS {
            if let Some(permit) = permit.as_ref() {
                rate_limits.completed(permit).await;
            }
            if response.status().is_success() {
                if let Some(transition) = throttle
                    .record_success(&request.model, request.model_class)
                    .await
                {
                    metrics.record_transition(&request.model, transition);
                    log_auto_transition(client, &request.model, transition);
                }
            }
            return Ok(UpstreamResult {
                candidate_index,
                response,
                throttle: admission,
                upstream_attempt,
                response_event_emitted: false,
            });
        }
        let (response, details, rate_limit_body) = match inspect_rate_limit_response(response).await
        {
            Ok(inspected) => inspected,
            Err(error) => {
                admission.release().await;
                if let Some(permit) = permit.as_ref() {
                    rate_limits.completed(permit).await;
                }
                return Err(error.into());
            }
        };
        if let Some(feeds) = metrics.feeds().filter(|feeds| feeds.http.is_active()) {
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok());
            if let Some(body) = feeds.response_body(
                &rate_limit_body,
                rate_limit_body.len(),
                content_type,
                Some(0),
            ) {
                let event = upstream_response_event(
                    &feeds,
                    caller,
                    request,
                    upstream_attempt,
                    Some(StatusCode::TOO_MANY_REQUESTS),
                    Some(attempt_started.elapsed()),
                    None,
                    candidate_index,
                    Some(response.headers()),
                    Some(body),
                );
                let _ = feeds.http.publish(event);
            }
        }
        let input_token_limit = details
            .message
            .as_deref()
            .is_some_and(is_input_limit_message);
        metrics.record_upstream_429(&request.model, input_token_limit);
        if input_token_limit && admission.active {
            throttle.record_input_429_after_admission();
        }
        admission.release().await;
        activate_token_throttle(
            throttle,
            metrics,
            client,
            &request.model,
            request.model_class,
            &details,
        )
        .await;
        let exhausted = retries >= policy.max_retries;
        if exhausted {
            if let Some(permit) = permit.as_ref() {
                let cooldown = server_retry_after(response.headers(), &details)
                    .map(|(delay, _)| delay)
                    .or(details.retry_after)
                    .unwrap_or(policy.max_delay);
                rate_limits.rejected_for_fallback(permit, cooldown).await;
            }
            metrics.record_retry("exhausted", true);
            log_rate_limit(RetryLog {
                client,
                caller,
                model: &request.model,
                upstream_attempt,
                retry: retries,
                policy,
                delay: std::time::Duration::ZERO,
                delay_source: "exhausted",
                admission: &admission,
                details: &details,
            });
            return Ok(UpstreamResult {
                candidate_index,
                response,
                throttle: admission,
                upstream_attempt,
                response_event_emitted: true,
            });
        }
        let server_delay = server_retry_after(response.headers(), &details);
        let remaining_delays = policy.max_retries.saturating_sub(retries).max(1);
        let (recovery_horizon, delay_source, incremental) =
            if let Some((delay, source)) = server_delay {
                (delay, source, true)
            } else if input_token_limit {
                match throttle
                    .token_window_delay(&request.model, request.model_class, request.estimate)
                    .await
                {
                    Some(delay) => (delay, "token-window", true),
                    None => {
                        throttle.record_fallback_window_delay();
                        (
                            std::time::Duration::from_secs(60),
                            "token-window-fallback",
                            true,
                        )
                    }
                }
            } else {
                (
                    backoff
                        .next()
                        .unwrap_or(policy.max_delay)
                        .min(policy.max_delay),
                    "backoff",
                    false,
                )
            };
        let can_fallback = model_fallback.enabled()
            && candidate_index + 1 < requests.len()
            && recovery_horizon > model_fallback.threshold;
        if can_fallback {
            if let Some(permit) = permit.as_ref() {
                rate_limits
                    .rejected_for_fallback(permit, recovery_horizon)
                    .await;
            }
            metrics.record_retry("model-fallback", false);
            tracing::warn!(
                host = client.host(),
                model = request.model,
                fallback_model = requests[candidate_index + 1].model,
                fallback_step = candidate_index + 1,
                recovery_horizon_ms = recovery_horizon.as_millis(),
                upstream_attempt,
                "rate limit triggered same-family model fallback"
            );
            last_rate_limit = Some(UpstreamResult {
                candidate_index,
                response,
                throttle: admission,
                upstream_attempt,
                response_event_emitted: true,
            });
            retries += 1;
            continue;
        }
        let delay = if incremental {
            policy.incremental_delay(recovery_horizon, remaining_delays)
        } else {
            recovery_horizon
        };
        if let Some(permit) = permit.as_ref() {
            rate_limits.rejected(permit, delay).await;
        } else {
            tokio::time::sleep(delay).await;
        }
        metrics.record_retry(delay_source, false);
        log_rate_limit(RetryLog {
            client,
            caller,
            model: &request.model,
            upstream_attempt,
            retry: retries + 1,
            policy,
            delay,
            delay_source,
            admission: &admission,
            details: &details,
        });
        last_rate_limit = Some(UpstreamResult {
            candidate_index,
            response,
            throttle: admission,
            upstream_attempt,
            response_event_emitted: true,
        });
        retries += 1;
    }
}

fn upstream_request_event(
    feeds: &ProxyFeeds,
    caller: &RequestCaller,
    request: &UpstreamRequest,
    attempt: u32,
    fallback_step: usize,
) -> HttpExchangeEvent {
    let content_type = request
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    HttpExchangeEvent::from_request(HttpRequestEvent {
        request_id: caller.request_id,
        hop: RequestHop::ProxyToUpstream,
        elapsed_ms: elapsed_ms(caller.started),
        attempt: Some(attempt),
        method: Method::POST.to_string(),
        host: Some(caller.upstream_host.clone()),
        path: request.path.clone(),
        headers: Some(feeds.headers(&request.headers)),
        body_bytes: Some(request.body.len() as u64),
        client_protocol: None,
        target_protocol: request.target.map(|target| target.label().to_owned()),
        preferred_model: Some(caller.preferred_model.clone()),
        actual_model: Some(request.model.clone()),
        streaming: None,
        fallback_step: Some(u32::try_from(fallback_step).unwrap_or(u32::MAX)),
        body: feeds.request_body(&request.body, content_type, 0),
    })
}

#[allow(clippy::too_many_arguments)]
fn upstream_response_event(
    feeds: &ProxyFeeds,
    caller: &RequestCaller,
    request: &UpstreamRequest,
    attempt: u32,
    status: Option<StatusCode>,
    duration: Option<std::time::Duration>,
    transport_error: Option<String>,
    fallback_step: usize,
    response_headers: Option<&HeaderMap>,
    body: Option<crate::events::HttpBodyContent>,
) -> HttpExchangeEvent {
    HttpExchangeEvent::from_response(HttpResponseEvent {
        request_id: caller.request_id,
        hop: ResponseHop::UpstreamToProxy,
        elapsed_ms: elapsed_ms(caller.started),
        duration_ms: duration.map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64),
        attempt: Some(attempt),
        method: Method::POST.to_string(),
        host: Some(caller.upstream_host.clone()),
        path: request.path.clone(),
        status: status.map(|status| status.as_u16()),
        headers: response_headers.map(|headers| feeds.headers(headers)),
        response_bytes: body.as_ref().map(|body| body.total_bytes),
        client_protocol: None,
        target_protocol: request.target.map(|target| target.label().to_owned()),
        preferred_model: Some(caller.preferred_model.clone()),
        actual_model: Some(request.model.clone()),
        streaming: None,
        fallback_step: Some(u32::try_from(fallback_step).unwrap_or(u32::MAX)),
        transport_error,
        body,
        sse: None,
    })
}

fn rate_limit_wait_exhausted(
    last_rate_limit: Option<UpstreamResult>,
    model: &str,
    max_wait: std::time::Duration,
) -> Result<UpstreamResult, ProxyError> {
    last_rate_limit.ok_or_else(|| ProxyError::RateLimitWait {
        model: model.to_owned(),
        wait_ms: max_wait.as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

/// Activate auto TPM admission once Databricks reports an input-token limit.
async fn activate_token_throttle(
    throttle: &RequestThrottle,
    metrics: &MetricsRuntime,
    client: &DatabricksClient,
    model: &str,
    model_class: Option<ModelClass>,
    details: &RateLimitDetails,
) {
    match throttle
        .activate_from_message(model, model_class, details.message.as_deref())
        .await
    {
        AutoActivation::Ignored => {}
        AutoActivation::Unavailable => tracing::warn!(
            host = client.host(),
            model,
            "automatic token rate limiting has no local input budget"
        ),
        AutoActivation::Transition(transition) => {
            metrics.record_transition(model, transition);
            log_auto_transition(client, model, transition)
        }
    }
}

fn log_auto_transition(client: &DatabricksClient, model: &str, transition: AutoTransition) {
    let fields = (
        transition.penalty_basis_points,
        transition.base_input_budget,
        transition.effective_input_budget,
    );
    match transition.kind {
        AutoTransitionKind::Activated
        | AutoTransitionKind::Tightened
        | AutoTransitionKind::Reactivated => tracing::warn!(
            host = client.host(),
            model,
            transition = ?transition.kind,
            penalty_basis_points = fields.0,
            base_input_budget = fields.1,
            effective_input_budget = fields.2,
            "automatic token rate limiting changed"
        ),
        AutoTransitionKind::Relaxed | AutoTransitionKind::Deactivated => tracing::info!(
            host = client.host(),
            model,
            transition = ?transition.kind,
            penalty_basis_points = fields.0,
            base_input_budget = fields.1,
            effective_input_budget = fields.2,
            "automatic token rate limiting changed"
        ),
    }
}

struct RetryLog<'a> {
    client: &'a DatabricksClient,
    caller: &'a RequestCaller,
    model: &'a str,
    upstream_attempt: u32,
    retry: u32,
    policy: RateLimitPolicy,
    delay: std::time::Duration,
    delay_source: &'a str,
    admission: &'a ThrottleAcquisition,
    details: &'a RateLimitDetails,
}

/// Log a 429 and any Databricks error message without exposing request payloads.
fn log_rate_limit(log: RetryLog<'_>) {
    let exhausted = log.delay_source == "exhausted";
    tracing::warn!(
        host = log.client.host(),
        model = log.model,
        retry = log.retry,
        max_retries = log.policy.max_retries,
        retry_delay_ms = log.delay.as_millis(),
        retry_delay_source = log.delay_source,
        rate_limit_message = log.details.message.as_deref().unwrap_or_default(),
        token_throttle_active = log.admission.active,
        penalty_basis_points = log.admission.penalty_basis_points,
        effective_input_budget = log.admission.input_window_budget,
        exhausted,
        "model request rate limited"
    );
    tracing::debug!(
        host = log.client.host(),
        model = log.model,
        retry = log.retry,
        max_retries = log.policy.max_retries,
        upstream_attempt = log.upstream_attempt,
        retry_delay_ms = log.delay.as_millis(),
        retry_delay_source = log.delay_source,
        rate_limit_message = log.details.message.as_deref().unwrap_or_default(),
        limit_type = log.details.limit_type.as_deref().unwrap_or_default(),
        limit = log.details.limit.unwrap_or_default(),
        current = log.details.current.unwrap_or_default(),
        token_throttle_mode = ?log.admission.mode,
        token_throttle_active = log.admission.active,
        token_limit_input = log.admission.input_limit,
        token_window_budget = log.admission.input_window_budget,
        token_penalty_basis_points = log.admission.penalty_basis_points,
        token_queue_depth = log.admission.queue_depth,
        token_reservation_input = log.admission.reserved_input_tokens,
        token_window_used_before = log.admission.input_window_used_before,
        token_window_wait_ms = log.admission.wait.as_millis(),
        client_ip = %log.caller.peer.ip(),
        client_port = log.caller.peer.port(),
        exhausted,
        "model request rate-limit details"
    );
}

/// Buffer a 429 for metadata inspection and rebuild it for retries or forwarding.
async fn inspect_rate_limit_response(
    response: reqwest::Response,
) -> Result<(reqwest::Response, RateLimitDetails, Bytes), DatabricksClientError> {
    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let body = response.bytes().await?;
    let details = rate_limit_details(&body);
    let mut rebuilt = axum::http::Response::new(body.clone());
    *rebuilt.status_mut() = status;
    *rebuilt.version_mut() = version;
    *rebuilt.headers_mut() = headers;
    Ok((reqwest::Response::from(rebuilt), details, body))
}

fn requested_model(input: &Value) -> Result<&str, ProxyError> {
    input
        .get("model")
        .and_then(Value::as_str)
        .ok_or(ProxyError::MissingModel)
}

fn embedding_invocation_path(model: &str) -> String {
    format!("/serving-endpoints/{model}/invocations")
}

fn prepare_embedding_request(
    mut input: Value,
    resolved_model: &str,
) -> Result<(String, Vec<u8>), ProxyError> {
    input["model"] = Value::String(resolved_model.to_owned());
    Ok((
        embedding_invocation_path(resolved_model),
        serde_json::to_vec(&input)?,
    ))
}

fn upstream_headers(originator: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Some(originator) = originator.filter(|value| is_codex_originator(value)) {
        headers.insert(
            HeaderName::from_static(ORIGINATOR_HEADER),
            HeaderValue::from_str(originator).expect("validated request header"),
        );
    }
    headers
}

fn request_originator(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(ORIGINATOR_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Resolve the logical principal and preserve the TCP peer used for diagnostics.
fn request_caller(
    headers: &HeaderMap,
    client: &DatabricksClient,
    peer: SocketAddr,
    request_id: u64,
    started: Instant,
    preferred_model: &str,
) -> RequestCaller {
    RequestCaller {
        request_id,
        started,
        preferred_model: preferred_model.to_owned(),
        upstream_host: client.host().to_owned(),
        principal: request_principal(headers, client),
        peer,
    }
}

fn request_principal(headers: &HeaderMap, client: &DatabricksClient) -> String {
    [USER_ID_HEADER, USER_EMAIL_HEADER]
        .into_iter()
        .find_map(|name| headers.get(name))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| jwt_principal(headers))
        .unwrap_or_else(|| client.principal().to_owned())
}

fn jwt_principal(headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_once(' ')
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))?
        .1;
    let payload = token.split('.').nth(1)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    [
        "sub",
        "user_id",
        "oid",
        "client_id",
        "azp",
        "email",
        "preferred_username",
    ]
    .into_iter()
    .find_map(|claim| claims.get(claim).and_then(Value::as_str))
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
}

fn upstream_status(response: &reqwest::Response) -> Result<StatusCode, ProxyError> {
    StatusCode::from_u16(response.status().as_u16())
        .map_err(|error| ProxyError::Upstream(error.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn publish_buffered_upstream_body(
    feeds: &ProxyFeeds,
    caller: &RequestCaller,
    actual_model: &str,
    path: &str,
    target: Option<TargetWire>,
    attempt: u32,
    fallback_step: usize,
    upstream: &BufferedUpstream,
) {
    if !feeds.http.is_active() {
        return;
    }
    let content_type = upstream
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let Some(body) =
        feeds.response_body(&upstream.body, upstream.body.len(), content_type, Some(0))
    else {
        return;
    };
    let _ = feeds
        .http
        .publish(HttpExchangeEvent::from_response(HttpResponseEvent {
            request_id: caller.request_id,
            hop: ResponseHop::UpstreamToProxy,
            elapsed_ms: elapsed_ms(caller.started),
            duration_ms: None,
            attempt: Some(attempt),
            method: Method::POST.to_string(),
            host: Some(caller.upstream_host.clone()),
            path: path.to_owned(),
            status: Some(upstream.status.as_u16()),
            headers: Some(feeds.headers(&upstream.headers)),
            response_bytes: Some(upstream.body.len() as u64),
            client_protocol: None,
            target_protocol: target.map(|target| target.label().to_owned()),
            preferred_model: Some(caller.preferred_model.clone()),
            actual_model: Some(actual_model.to_owned()),
            streaming: Some(false),
            fallback_step: Some(u32::try_from(fallback_step).unwrap_or(u32::MAX)),
            transport_error: None,
            body: Some(body),
            sse: None,
        }));
}

struct BufferedUpstream {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl BufferedUpstream {
    fn into_raw_response(self) -> Response {
        let Self {
            status,
            headers,
            body,
        } = self;
        response_from_parts(status, headers, body, None)
    }

    fn into_json_response(self, body: Vec<u8>) -> Response {
        response_from_parts(
            self.status,
            self.headers,
            Bytes::from(body),
            Some(HeaderValue::from_static("application/json")),
        )
    }
}

fn response_from_parts(
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
    content_type: Option<HeaderValue>,
) -> Response {
    let mut response = (status, body).into_response();
    *response.headers_mut() = headers;
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

async fn buffered_response(response: reqwest::Response) -> Result<BufferedUpstream, ProxyError> {
    let status = upstream_status(&response)?;
    let headers = forwarded_response_headers(response.headers());
    let body = response
        .bytes()
        .await
        .map_err(|error| ProxyError::Upstream(error.to_string()))?;
    Ok(BufferedUpstream {
        status,
        headers,
        body,
    })
}

fn forwarded_response_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut forwarded = HeaderMap::new();
    for (name, value) in upstream {
        let name_text = name.as_str();
        if name == header::CONTENT_TYPE
            || name == header::RETRY_AFTER
            || name_text.contains("request-id")
            || name_text.contains("correlation-id")
            || name_text.contains("ratelimit")
            || name_text.contains("rate-limit")
            || name_text.contains("quota")
            || name_text.starts_with("x-databricks-limit")
            || name_text.starts_with("x-model-proxy-")
        {
            forwarded.append(name.clone(), value.clone());
        }
    }
    forwarded
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    use dbx_tools_core::DatabricksAuthOptions;
    use dbx_tools_model::ReasoningEffort;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, Request, Respond, ResponseTemplate,
    };

    use super::*;

    #[derive(Clone, Default)]
    struct RateLimitedOnce(Arc<AtomicUsize>);

    impl Respond for RateLimitedOnce {
        fn respond(&self, _request: &Request) -> ResponseTemplate {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(429).set_body_json(json!({
                    "error": {
                        "message": "Exceeded workspace input tokens per minute",
                        "retry_after": 0
                    }
                }))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({"ok": true}))
            }
        }
    }

    #[derive(Clone, Default)]
    struct ModelFallbackResponder {
        primary: Arc<AtomicUsize>,
        fallback: Arc<AtomicUsize>,
    }

    impl Respond for ModelFallbackResponder {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let model = serde_json::from_slice::<Value>(&request.body)
                .unwrap()
                .get("model")
                .and_then(Value::as_str)
                .unwrap()
                .to_owned();
            if model == "primary" {
                self.primary.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "60")
                    .set_body_json(json!({"error": {"message": "rate limited"}}))
            } else {
                self.fallback.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(json!({"model": model}))
            }
        }
    }

    #[derive(Clone, Default)]
    struct SuccessfulModelResponder {
        primary: Arc<AtomicUsize>,
        fallback: Arc<AtomicUsize>,
    }

    impl Respond for SuccessfulModelResponder {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let model = serde_json::from_slice::<Value>(&request.body)
                .unwrap()
                .get("model")
                .and_then(Value::as_str)
                .unwrap()
                .to_owned();
            if model == "primary" {
                self.primary.fetch_add(1, Ordering::SeqCst);
            } else {
                self.fallback.fetch_add(1, Ordering::SeqCst);
            }
            ResponseTemplate::new(200).set_body_json(json!({"model": model}))
        }
    }

    async fn test_client(server: &MockServer) -> DatabricksClient {
        let directory = tempfile::tempdir().unwrap();
        let config_file = directory.path().join("databrickscfg");
        std::fs::write(
            &config_file,
            format!(
                "[DEFAULT]\nhost = {}\nauth_type = pat\ntoken = test-token\n",
                server.uri()
            ),
        )
        .unwrap();
        DatabricksClient::with_options(DatabricksAuthOptions {
            profile: Some("DEFAULT".into()),
            host: Some(server.uri()),
            config_file: Some(config_file.to_string_lossy().into_owned()),
            cache_dir: Some(directory.path().join("auth").to_string_lossy().into_owned()),
            prefer_user_to_machine: false,
            ..Default::default()
        })
        .await
        .unwrap()
    }

    fn test_caller() -> RequestCaller {
        RequestCaller {
            request_id: 1,
            started: Instant::now(),
            preferred_model: "model".to_owned(),
            upstream_host: "https://workspace.example".to_owned(),
            principal: "principal".to_owned(),
            peer: "127.0.0.1:54321".parse().unwrap(),
        }
    }

    fn test_metrics() -> MetricsRuntime {
        MetricsRuntime::new(crate::metrics::MetricsConfig {
            mode: crate::metrics::MetricsMode::Off,
            routes_visible: false,
        })
        .unwrap()
    }

    fn disabled_model_fallback() -> ModelFallbackPolicy {
        ModelFallbackPolicy {
            mode: crate::rate_limit::ModelFallbackMode::Off,
            ..Default::default()
        }
    }

    fn test_upstream_request(model: &str) -> UpstreamRequest {
        UpstreamRequest {
            model: model.to_owned(),
            model_class: None,
            estimate: TokenEstimate {
                input: 1,
                output: 0,
            },
            path: "/test".to_owned(),
            headers: upstream_headers(None),
            body: serde_json::to_vec(&json!({"model": model})).unwrap(),
            target: Some(TargetWire::Responses),
        }
    }

    fn test_endpoint(name: &str) -> ServingEndpointSummary {
        ServingEndpointSummary {
            name: name.to_owned(),
            display_name: None,
            family: Some("gpt".to_owned()),
            task: Some("llm/v1/chat".to_owned()),
            state: Some("READY".to_owned()),
            description: None,
            supports_tools: Some(true),
            profile: None,
            model_class: Some(ModelClass::ChatBalanced),
            service_names: Default::default(),
            model_service_name: None,
            reasoning_efforts: vec![ReasoningEffort::High],
            status: Default::default(),
            dimension: None,
        }
    }

    #[test]
    fn upstream_events_distinguish_preferred_and_actual_models() {
        let caller = RequestCaller {
            request_id: 42,
            started: Instant::now(),
            preferred_model: "preferred".into(),
            upstream_host: "https://workspace.example".into(),
            principal: "principal".into(),
            peer: "127.0.0.1:1234".parse().unwrap(),
        };
        let request = test_upstream_request("fallback");
        let feeds = ProxyFeeds::new(None, false).unwrap();
        let request_event = upstream_request_event(&feeds, &caller, &request, 2, 1);
        let event = upstream_response_event(
            &feeds,
            &caller,
            &request,
            2,
            Some(StatusCode::OK),
            Some(Duration::from_millis(15)),
            None,
            1,
            None,
            None,
        );

        let request = request_event.request.unwrap();
        assert_eq!(request.request_id, 42);
        assert_eq!(request.preferred_model.as_deref(), Some("preferred"));
        assert_eq!(request.actual_model.as_deref(), Some("fallback"));
        assert_eq!(request.fallback_step, Some(1));
        assert_eq!(request.host.as_deref(), Some("https://workspace.example"));
        let response = event.response.unwrap();
        assert_eq!(response.status, Some(200));
        assert_eq!(response.duration_ms, Some(15));
    }

    #[test]
    fn openapi_documents_runtime_rest_and_protocol_routes() {
        let document = serde_json::to_value(openapi()).unwrap();
        let paths = document["paths"].as_object().unwrap();
        for path in [
            "/api/auth",
            "/api/auth/profiles",
            "/api/healthz",
            "/api/rate-limits/models/{model}/cancel-waits",
            "/api/rate-limits/models/{model}/retry-now",
            "/v1/chat/completions",
            "/v1/embeddings",
            "/v1/messages",
            "/v1/models",
            "/v1/responses",
        ] {
            assert!(paths.contains_key(path), "missing OpenAPI path {path}");
        }
        assert!(!paths.contains_key("/graphql"));
        assert!(document["components"]["schemas"]["HealthResponse"].is_object());
        assert!(document["components"]["schemas"]["AuthStatusResponse"].is_object());
        assert!(document["components"]["schemas"]["ModelSnapshot"].is_null());
        let chat = &document["paths"]["/v1/chat/completions"]["post"];
        assert!(chat["requestBody"]["content"]["application/json"].is_object());
        assert!(chat["responses"]["200"]["content"]["application/json"].is_object());
        assert!(chat["responses"]["200"]["content"]["text/event-stream"].is_object());
    }

    #[test]
    fn fallback_candidates_must_preserve_request_capabilities() {
        let input = json!({
            "model": "primary",
            "messages": [{"role": "user", "content": "hello"}],
            "reasoning_effort": "high",
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {}}}]
        });
        let mut endpoint = test_endpoint("databricks-gpt-5-3");
        assert!(fallback_compatible(
            ClientWire::Chat,
            TargetWire::Auto,
            None,
            false,
            &input,
            ReasoningSetting::Effort(ReasoningEffort::High),
            &endpoint,
            None,
        ));

        endpoint.supports_tools = Some(false);
        assert!(!fallback_compatible(
            ClientWire::Chat,
            TargetWire::Auto,
            None,
            false,
            &input,
            ReasoningSetting::Effort(ReasoningEffort::High),
            &endpoint,
            None,
        ));

        endpoint.supports_tools = Some(true);
        endpoint.reasoning_efforts.clear();
        assert!(!fallback_compatible(
            ClientWire::Chat,
            TargetWire::Auto,
            None,
            false,
            &input,
            ReasoningSetting::Effort(ReasoningEffort::High),
            &endpoint,
            None,
        ));
    }

    #[test]
    fn embeddings_use_the_resolved_endpoint_invocation_path() {
        let (path, body) = prepare_embedding_request(
            json!({"model": "gte", "input": ["one", "two"], "encoding_format": "float"}),
            "databricks-gte-large-en",
        )
        .unwrap();
        assert_eq!(
            path,
            "/serving-endpoints/databricks-gte-large-en/invocations"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({
                "model": "databricks-gte-large-en",
                "input": ["one", "two"],
                "encoding_format": "float"
            })
        );
    }

    #[tokio::test]
    async fn retries_rate_limits_after_updating_the_shared_gate() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(RateLimitedOnce::default())
            .expect(2)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();

        let response = tokio::time::timeout(
            Duration::from_millis(900),
            send_upstream(
                UpstreamControls {
                    client: &client,
                    model_fallback: disabled_model_fallback(),
                    rate_limits: &gate,
                    throttle: &throttle,
                    metrics: &metrics,
                },
                &caller,
                &[UpstreamRequest {
                    model: "model".to_owned(),
                    model_class: None,
                    estimate: TokenEstimate {
                        input: 1,
                        output: 0,
                    },
                    path: "/test".to_owned(),
                    headers: upstream_headers(None),
                    body: br#"{"model":"model"}"#.to_vec(),
                    target: None,
                }],
            ),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::OK);
        assert_eq!(response.upstream_attempt, 2);
        let counters = throttle.counters().await;
        assert_eq!(counters.automatic_activations, 1);
        assert_eq!(counters.retry_reacquisitions, 1);
        assert!(matches!(
            throttle
                .activate_from_message(
                    "model",
                    None,
                    Some("Exceeded workspace input tokens per minute"),
                )
                .await,
            AutoActivation::Transition(AutoTransition {
                kind: AutoTransitionKind::Tightened,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn long_rate_limit_wait_falls_back_and_keeps_primary_cooling_down() {
        let server = MockServer::start().await;
        let responder = ModelFallbackResponder::default();
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(responder.clone())
            .expect(3)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_secs(60),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Off,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();
        let candidates = [
            test_upstream_request("primary"),
            test_upstream_request("fallback"),
        ];
        let fallback = ModelFallbackPolicy::default();

        let first = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: fallback,
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &candidates,
        )
        .await
        .unwrap();
        assert_eq!(first.response.status(), StatusCode::OK);
        assert_eq!(first.candidate_index, 1);
        assert_eq!(first.upstream_attempt, 2);

        let second = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: fallback,
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &candidates,
        )
        .await
        .unwrap();
        assert_eq!(second.response.status(), StatusCode::OK);
        assert_eq!(second.candidate_index, 1);
        assert_eq!(second.upstream_attempt, 1);
        assert_eq!(responder.primary.load(Ordering::SeqCst), 1);
        assert_eq!(responder.fallback.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn long_local_token_wait_uses_fallback_before_queueing() {
        let server = MockServer::start().await;
        let responder = SuccessfulModelResponder::default();
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(responder.clone())
            .expect(2)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_secs(60),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();
        assert!(matches!(
            throttle
                .activate_from_message(
                    "primary",
                    None,
                    Some("Exceeded workspace input tokens per minute"),
                )
                .await,
            AutoActivation::Transition(_)
        ));
        let mut primary = test_upstream_request("primary");
        primary.estimate.input = 80;
        let first = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[primary],
        )
        .await
        .unwrap();
        assert_eq!(first.candidate_index, 0);

        let mut primary = test_upstream_request("primary");
        primary.estimate.input = 20;
        let mut fallback = test_upstream_request("fallback");
        fallback.estimate.input = 20;
        let second = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: ModelFallbackPolicy::default(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[primary, fallback],
        )
        .await
        .unwrap();

        assert_eq!(second.candidate_index, 1);
        assert_eq!(second.upstream_attempt, 1);
        assert_eq!(responder.primary.load(Ordering::SeqCst), 1);
        assert_eq!(responder.fallback.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn total_wait_budget_returns_the_original_rate_limit_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "60")
                    .set_body_json(json!({"error": {"message": "quota exhausted"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            max_wait: Duration::from_millis(30),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Off,
                documented_limits: Default::default(),
            },
        );
        let started = tokio::time::Instant::now();
        let response = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &test_metrics(),
            },
            &test_caller(),
            &[test_upstream_request("primary")],
        )
        .await
        .unwrap();

        assert!(started.elapsed() < Duration::from_millis(200));
        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.upstream_attempt, 1);
        assert_eq!(
            response.response.bytes().await.unwrap(),
            br#"{"error":{"message":"quota exhausted"}}"#.as_slice()
        );
    }

    #[tokio::test]
    async fn operator_cancellation_returns_the_latest_upstream_rate_limit() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "60")
                    .set_body_json(json!({"error": {"message": "quota exhausted"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            max_wait: Duration::from_secs(5),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Off,
                documented_limits: Default::default(),
            },
        );
        let metrics = test_metrics();
        let caller = test_caller();
        let requests = [test_upstream_request("primary")];
        let sending = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &requests,
        );
        let cancelling = async {
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    if gate
                        .model_snapshots()
                        .await
                        .iter()
                        .any(|snapshot| snapshot.waiters > 0)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            gate.cancel_waits("primary").await
        };
        let (response, cancellation) = tokio::join!(sending, cancelling);
        let response = response.unwrap();

        assert_eq!(cancellation.cancelled_waiters, 1);
        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.upstream_attempt, 1);
        assert_eq!(
            response.response.bytes().await.unwrap(),
            br#"{"error":{"message":"quota exhausted"}}"#.as_slice()
        );
    }

    #[tokio::test]
    async fn zero_retries_disables_rate_limit_recovery() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "60")
                    .set_body_json(json!({"error": {"message": "quota exhausted"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 0,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Off,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();

        let response = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[UpstreamRequest {
                model: "model".to_owned(),
                model_class: None,
                estimate: TokenEstimate {
                    input: 1,
                    output: 0,
                },
                path: "/test".to_owned(),
                headers: upstream_headers(None),
                body: Vec::new(),
                target: None,
            }],
        )
        .await
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.upstream_attempt, 1);
        assert_eq!(
            response.response.bytes().await.unwrap(),
            br#"{"error":{"message":"quota exhausted"}}"#.as_slice()
        );
    }

    #[tokio::test]
    async fn permanently_rate_limited_upstream_stops_after_configured_retries() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "0")
                    .set_body_json(json!({"error": {"message": "request count exceeded"}})),
            )
            .expect(3)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 2,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Off,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();

        let response = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[UpstreamRequest {
                model: "model".to_owned(),
                model_class: None,
                estimate: TokenEstimate {
                    input: 1,
                    output: 0,
                },
                path: "/test".to_owned(),
                headers: upstream_headers(None),
                body: Vec::new(),
                target: None,
            }],
        )
        .await
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.upstream_attempt, 3);
    }

    #[tokio::test]
    async fn final_input_token_429_tightens_adaptive_state() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": {
                    "message": "Exceeded workspace input tokens per minute",
                    "retry_after": 0
                }
            })))
            .expect(2)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();

        let response = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[UpstreamRequest {
                model: "model".to_owned(),
                model_class: None,
                estimate: TokenEstimate {
                    input: 1,
                    output: 0,
                },
                path: "/test".to_owned(),
                headers: upstream_headers(None),
                body: Vec::new(),
                target: None,
            }],
        )
        .await
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        let counters = throttle.counters().await;
        assert_eq!(counters.automatic_activations, 1);
        assert_eq!(counters.automatic_tightenings, 1);
        assert_eq!(counters.retry_reacquisitions, 1);
        assert_eq!(counters.auto_active_keys, 1);
    }

    #[tokio::test]
    async fn oversized_input_is_rejected_before_upstream_send() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let client = test_client(&server).await;
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            max_wait: Duration::from_secs(60),
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::On,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();
        let metrics = test_metrics();

        let error = send_upstream(
            UpstreamControls {
                client: &client,
                model_fallback: disabled_model_fallback(),
                rate_limits: &gate,
                throttle: &throttle,
                metrics: &metrics,
            },
            &caller,
            &[UpstreamRequest {
                model: "model".to_owned(),
                model_class: None,
                estimate: TokenEstimate {
                    input: 101,
                    output: 0,
                },
                path: "/test".to_owned(),
                headers: upstream_headers(None),
                body: Vec::new(),
                target: None,
            }],
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            ProxyError::OversizedInput {
                estimated_input_tokens: 101,
                input_limit: 100,
                ..
            }
        ));
        assert_eq!(throttle.counters().await.oversized_rejections, 1);
    }

    #[test]
    fn codex_originator_is_forwarded() {
        assert!(is_codex_originator(" Codex_CLI_RS "));
        assert_eq!(
            upstream_headers(Some("Codex_CLI_RS"))
                .get(ORIGINATOR_HEADER)
                .unwrap(),
            "Codex_CLI_RS"
        );
        assert!(upstream_headers(Some("other-client"))
            .get(ORIGINATOR_HEADER)
            .is_none());
    }

    #[test]
    fn reads_principal_from_an_unverified_bearer_jwt_without_network_access() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"service-principal-id"}"#);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer header.{payload}.signature")
                .parse()
                .unwrap(),
        );

        assert_eq!(
            jwt_principal(&headers).as_deref(),
            Some("service-principal-id")
        );
    }

    #[test]
    fn forwards_structured_rate_limit_metadata_only() {
        let mut upstream = HeaderMap::new();
        upstream.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        upstream.insert(header::RETRY_AFTER, HeaderValue::from_static("12"));
        upstream.insert(
            HeaderName::from_static("x-databricks-request-id"),
            HeaderValue::from_static("request-1"),
        );
        upstream.insert(
            HeaderName::from_static("x-ratelimit-limit-tokens"),
            HeaderValue::from_static("1000"),
        );
        upstream.insert(
            HeaderName::from_static("x-databricks-quota-name"),
            HeaderValue::from_static("tokens-per-minute"),
        );
        add_fallback_headers(&mut upstream, "primary", "fallback", 1);
        upstream.insert(header::SERVER, HeaderValue::from_static("internal"));

        let forwarded = forwarded_response_headers(&upstream);

        assert_eq!(
            forwarded.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(forwarded.get(header::RETRY_AFTER).unwrap(), "12");
        assert_eq!(
            forwarded.get("x-databricks-request-id").unwrap(),
            "request-1"
        );
        assert_eq!(forwarded.get("x-ratelimit-limit-tokens").unwrap(), "1000");
        assert_eq!(
            forwarded.get("x-databricks-quota-name").unwrap(),
            "tokens-per-minute"
        );
        assert_eq!(
            forwarded.get(FALLBACK_PREFERRED_MODEL_HEADER).unwrap(),
            "primary"
        );
        assert_eq!(
            forwarded.get(FALLBACK_RESOLVED_MODEL_HEADER).unwrap(),
            "fallback"
        );
        assert_eq!(forwarded.get(FALLBACK_STEP_HEADER).unwrap(), "1");
        assert!(forwarded.get(header::SERVER).is_none());
    }

    #[test]
    fn raw_upstream_response_keeps_json_content_type_and_body() {
        let response = BufferedUpstream {
            status: StatusCode::TOO_MANY_REQUESTS,
            headers: HeaderMap::from_iter([
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                ),
                (header::RETRY_AFTER, HeaderValue::from_static("5")),
            ]),
            body: Bytes::from_static(br#"{"error_code":"RATE_LIMIT_EXCEEDED"}"#),
        }
        .into_raw_response();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::RETRY_AFTER], "5");
    }

    #[test]
    fn control_requests_require_loopback_same_origin_and_custom_header() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4000"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:4000"),
        );
        headers.insert(
            HeaderName::from_static(CONTROL_HEADER),
            HeaderValue::from_static("1"),
        );
        headers.insert(
            HeaderName::from_static("sec-fetch-site"),
            HeaderValue::from_static("same-origin"),
        );
        assert!(control_request_allowed(&headers));

        headers.remove(CONTROL_HEADER);
        assert!(!control_request_allowed(&headers));
        headers.insert(
            HeaderName::from_static(CONTROL_HEADER),
            HeaderValue::from_static("1"),
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example"),
        );
        assert!(!control_request_allowed(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://proxy.example"),
        );
        headers.insert(header::HOST, HeaderValue::from_static("proxy.example"));
        assert!(!control_request_allowed(&headers));
    }

    #[test]
    fn loopback_authority_accepts_supported_local_hosts_only() {
        assert!(is_loopback_authority("localhost:4000"));
        assert!(is_loopback_authority("127.0.0.1:4000"));
        assert!(is_loopback_authority("[::1]:4000"));
        assert!(!is_loopback_authority("0.0.0.0:4000"));
        assert!(!is_loopback_authority("proxy.example:4000"));
    }
}
