//! HTTP routes for model listing, generation, and embeddings.

use std::{net::SocketAddr, num::NonZeroUsize, time::Instant};

use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use dbx_tools_core::{DatabricksClient, DatabricksClientError};
use dbx_tools_model::{
    codex_model_name, is_responses_only, models_payload_with_capabilities, same_family_fallbacks,
    ModelCapabilities, ModelCapabilitiesResolver, ModelClass, ServingEndpointSummary,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::info;

use crate::{
    adapt::{adapt_request, adapt_response, select_request_target, upstream_path},
    adaptive::{AutoTransition, AutoTransitionKind},
    error::ProxyError,
    images::normalize_embedded_images,
    metrics::{MetricsRuntime, PeerAddr},
    protocol::{is_codex_originator, ClientWire, TargetWire},
    rate_limit::{
        rate_limit_details, server_retry_after, ModelFallbackPolicy, RateLimitDetails,
        RateLimitGate, RateLimitPolicy,
    },
    request_log::{ReasoningSetting, RequestLogContext, RequestLogMetadata},
    runtime::RuntimeManager,
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

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) capabilities: ModelCapabilitiesResolver,
    pub(crate) runtime: RuntimeManager,
    target: TargetWire,
    image_resize_threshold_bytes: usize,
    model_fallback: ModelFallbackPolicy,
    pub(crate) rate_limits: RateLimitGate,
    pub(crate) metrics: MetricsRuntime,
}

pub(crate) struct AppConfig {
    pub(crate) target: TargetWire,
    pub(crate) image_resize_threshold_bytes: usize,
    pub(crate) model_fallback: ModelFallbackPolicy,
    pub(crate) rate_limits: RateLimitPolicy,
    pub(crate) metrics: MetricsRuntime,
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
            model_fallback: config.model_fallback,
            rate_limits,
            metrics: config.metrics,
        }
    }

    pub(crate) fn metrics(&self) -> &MetricsRuntime {
        &self.metrics
    }
}

#[derive(Debug, Default, Deserialize)]
struct ModelsQuery {
    #[serde(default)]
    extended: bool,
    search: Option<String>,
}

/// Logical rate-limit principal and immediate transport peer for one request.
#[derive(Debug)]
struct RequestCaller {
    principal: String,
    peer: SocketAddr,
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
}

pub(crate) fn routes(state: AppState, max_request_bytes: NonZeroUsize) -> Router {
    let metrics = state.metrics.clone();
    let mut router = Router::new()
        .route("/api/healthz", get(health))
        .route("/v1/models", get(list_models))
        .route("/v1/embeddings", post(embeddings))
        .route(
            "/v1/chat/completions",
            post(
                |ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
                 State(state): State<AppState>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    proxy(state, ClientWire::Chat, peer, headers, body).await
                },
            ),
        )
        .route(
            "/v1/responses",
            post(
                |ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
                 State(state): State<AppState>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    proxy(state, ClientWire::Responses, peer, headers, body).await
                },
            ),
        )
        .route(
            "/v1/messages",
            post(
                |ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
                 State(state): State<AppState>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    proxy(state, ClientWire::Anthropic, peer, headers, body).await
                },
            ),
        );
    router = router.layer(DefaultBodyLimit::max(max_request_bytes.get()));
    if metrics.collection_enabled() {
        router = router.layer(middleware::from_fn_with_state(
            metrics.clone(),
            track_active_request,
        ));
    }
    router.with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "generation": state.runtime.status().generation
    }))
}

async fn track_active_request(
    State(metrics): State<MetricsRuntime>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    metrics.request_started();
    let _active_request = ActiveRequestGuard(metrics);
    next.run(request).await
}

struct ActiveRequestGuard(MetricsRuntime);

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.0.request_finished();
    }
}

async fn list_models(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
    headers: HeaderMap,
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

async fn embeddings(
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let runtime = state.runtime.capture();
    let started = Instant::now();
    let request_bytes = body.len();
    let input: Value = serde_json::from_slice(&body)?;
    let requested_model = requested_model(&input)?.to_owned();
    let endpoint = runtime
        .models
        .resolve_serving_endpoint_for_class(&requested_model, ModelClass::Embedding)
        .await?
        .ok_or_else(|| ProxyError::EmbeddingModelNotFound(requested_model.clone()))?;
    let estimate = runtime.throttle.estimate(&endpoint.name, &input);
    let caller = request_caller(&headers, &runtime.databricks, peer);
    let (path, request_body) = prepare_embedding_request(input, &endpoint.name)?;
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
    } = upstream;
    let upstream = buffered_response(response).await?;
    let usage = response_usage(&upstream.body);
    RequestLogContext::new(
        RequestLogMetadata {
            runtime_key: runtime.storage_key.clone(),
            requested_model,
            resolved_model: endpoint.name,
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
    Ok(upstream.into_raw_response())
}

async fn proxy(
    state: AppState,
    client_wire: ClientWire,
    peer: SocketAddr,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let runtime = state.runtime.capture();
    let started = Instant::now();
    let request_bytes = body.len();
    let mut input: Value = serde_json::from_slice(&body)?;
    normalize_embedded_images(&mut input, state.image_resize_threshold_bytes)?;
    let requested_model = requested_model(&input)?.to_owned();
    let reasoning_setting = ReasoningSetting::from_request(&input);
    let streaming = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let originator = request_originator(&headers);
    let caller = request_caller(&headers, &runtime.databricks, peer);
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
        request_log.stream_connected(client_wire, target, status);
        return stream_response(
            client_wire,
            target,
            upstream,
            model,
            response_headers,
            StreamLogContext {
                client_wire,
                target,
                request: request_log,
                _runtime: runtime,
            },
        );
    }
    let upstream = buffered_response(upstream).await?;
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
        return Ok(upstream.into_raw_response());
    }

    let output = adapt_response(client_wire, target, upstream.status, &upstream.body)?;
    let usage = response_usage(&output);
    request_log
        .complete_model(client_wire, target, streaming, upstream.status, usage)
        .await;
    Ok(upstream.into_json_response(output))
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
        let response = match client
            .request_builder(&request.path, Method::POST)?
            .headers(request.headers.clone())
            .body(request.body.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
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
            });
        }
        let (response, details) = match inspect_rate_limit_response(response).await {
            Ok(inspected) => inspected,
            Err(error) => {
                admission.release().await;
                if let Some(permit) = permit.as_ref() {
                    rate_limits.completed(permit).await;
                }
                return Err(error.into());
            }
        };
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
        });
        retries += 1;
    }
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
) -> Result<(reqwest::Response, RateLimitDetails), DatabricksClientError> {
    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let body = response.bytes().await?;
    let details = rate_limit_details(&body);
    let mut rebuilt = axum::http::Response::new(body);
    *rebuilt.status_mut() = status;
    *rebuilt.version_mut() = version;
    *rebuilt.headers_mut() = headers;
    Ok((reqwest::Response::from(rebuilt), details))
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
) -> RequestCaller {
    RequestCaller {
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
            principal: "principal".to_owned(),
            peer: "127.0.0.1:54321".parse().unwrap(),
        }
    }

    fn test_metrics() -> MetricsRuntime {
        MetricsRuntime::new(crate::metrics::MetricsConfig {
            mode: crate::metrics::MetricsMode::Off,
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
}
