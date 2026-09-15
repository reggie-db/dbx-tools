//! HTTP routes for model listing, generation, and embeddings.

use std::{net::SocketAddr, num::NonZeroUsize, time::Instant};

use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
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
    codex_model_name, is_responses_only, models_payload_with_capabilities,
    ModelCapabilitiesResolver, ModelClass, ModelClient,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::info;

use crate::{
    adapt::{adapt_request, adapt_response, select_request_target, upstream_path},
    error::ProxyError,
    images::normalize_embedded_images,
    protocol::{is_codex_originator, ClientWire, TargetWire},
    rate_limit::{
        rate_limit_details, server_retry_after, RateLimitDetails, RateLimitGate, RateLimitPolicy,
    },
    request_log::RequestLogContext,
    stream::{stream_response, StreamLogContext},
    throttle::{
        is_input_limit_message, response_token_usage, RequestThrottle, ResponseTokenUsage,
        ThrottleAcquisition, ThrottleConfig, TokenEstimate,
    },
};

const ORIGINATOR_HEADER: &str = "originator";
const USER_ID_HEADER: &str = "x-forwarded-user";
const USER_EMAIL_HEADER: &str = "x-forwarded-email";

#[derive(Clone)]
pub(crate) struct AppState {
    capabilities: ModelCapabilitiesResolver,
    databricks: DatabricksClient,
    models: ModelClient,
    target: TargetWire,
    throttle: RequestThrottle,
    image_resize_threshold_bytes: usize,
    rate_limits: RateLimitGate,
}

impl AppState {
    pub(crate) fn new(
        capabilities: ModelCapabilitiesResolver,
        databricks: DatabricksClient,
        models: ModelClient,
        target: TargetWire,
        throttle_config: ThrottleConfig,
        image_resize_threshold_bytes: usize,
        rate_limit_policy: RateLimitPolicy,
    ) -> Self {
        let throttle = RequestThrottle::new(databricks.host(), throttle_config);
        let rate_limits = RateLimitGate::new(rate_limit_policy);
        Self {
            capabilities,
            databricks,
            models,
            target,
            throttle,
            image_resize_threshold_bytes,
            rate_limits,
        }
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
    rate_limits: &'a RateLimitGate,
    throttle: &'a RequestThrottle,
}

struct UpstreamRequest<'a> {
    model: &'a str,
    model_class: Option<ModelClass>,
    estimate: TokenEstimate,
    path: &'a str,
    headers: HeaderMap,
    body: Vec<u8>,
}

#[derive(Debug)]
struct UpstreamResult {
    response: reqwest::Response,
    throttle: ThrottleAcquisition,
    upstream_attempt: u32,
}

pub(crate) fn routes(state: AppState, max_request_bytes: NonZeroUsize) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/models", get(list_models))
        .route("/v1/embeddings", post(embeddings))
        .route(
            "/v1/chat/completions",
            post(
                |ConnectInfo(peer): ConnectInfo<SocketAddr>,
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
                |ConnectInfo(peer): ConnectInfo<SocketAddr>,
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
                |ConnectInfo(peer): ConnectInfo<SocketAddr>,
                 State(state): State<AppState>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    proxy(state, ClientWire::Anthropic, peer, headers, body).await
                },
            ),
        )
        .layer(DefaultBodyLimit::max(max_request_bytes.get()))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let counters = state.throttle.counters();
    Json(json!({
        "status": "ok",
        "rateLimits": {
            "automaticActivations": counters.automatic_activations,
            "admissionWaits": counters.admission_waits,
            "oversizedRejections": counters.oversized_rejections,
            "input429AfterAdmission": counters.input_429_after_admission,
            "retryReacquisitions": counters.retry_reacquisitions,
            "fallbackWindowDelays": counters.fallback_window_delays
        }
    }))
}

async fn list_models(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ProxyError> {
    let started = Instant::now();
    let originator = request_originator(&headers);
    let codex = originator.is_some_and(is_codex_originator);
    let endpoints = state.models.list_serving_endpoints(false).await?;
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
        format = if codex { "codex" } else { "openai" },
        search = query.search.as_deref().unwrap_or_default(),
        extended = query.extended,
        models = count,
        client_ip = %peer.ip(),
        client_port = peer.port(),
        latency_ms = started.elapsed().as_millis(),
        "model request completed"
    );
    Ok(Json(payload))
}

async fn embeddings(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let request_bytes = body.len();
    let input: Value = serde_json::from_slice(&body)?;
    let requested_model = requested_model(&input)?.to_owned();
    let endpoint = state
        .models
        .resolve_serving_endpoint_for_class(&requested_model, ModelClass::Embedding)
        .await?
        .ok_or_else(|| ProxyError::EmbeddingModelNotFound(requested_model.clone()))?;
    let estimate = state.throttle.estimate(&endpoint.name, &input);
    let caller = request_caller(&headers, &state.databricks, peer);
    let (path, request_body) = prepare_embedding_request(input, &endpoint.name)?;
    let originator = request_originator(&headers);
    let upstream = send_upstream(
        UpstreamControls {
            client: &state.databricks,
            rate_limits: &state.rate_limits,
            throttle: &state.throttle,
        },
        &caller,
        UpstreamRequest {
            model: &endpoint.name,
            model_class: endpoint.model_class,
            estimate,
            path: &path,
            headers: upstream_headers(originator),
            body: request_body,
        },
    )
    .await?;
    let UpstreamResult {
        response,
        throttle,
        upstream_attempt,
    } = upstream;
    let upstream = buffered_response(response).await?;
    let usage = response_usage(&upstream.body);
    RequestLogContext::new(
        requested_model,
        endpoint.name,
        caller.peer,
        request_bytes,
        started,
        throttle,
        upstream_attempt,
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
    let started = Instant::now();
    let request_bytes = body.len();
    let mut input: Value = serde_json::from_slice(&body)?;
    normalize_embedded_images(&mut input, state.image_resize_threshold_bytes)?;
    let requested_model = requested_model(&input)?.to_owned();
    let streaming = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let originator = request_originator(&headers);
    let caller = request_caller(&headers, &state.databricks, peer);
    let codex = originator.is_some_and(is_codex_originator);
    let endpoint = state
        .models
        .resolve_serving_endpoint(&requested_model)
        .await?;
    let native_responses = if let Some(endpoint) = endpoint.as_ref() {
        if is_responses_only(&endpoint.name) {
            true
        } else {
            match state.capabilities.capabilities().await {
                Ok(capabilities) => capabilities.supports_responses(endpoint),
                Err(error) => {
                    tracing::warn!(%error, "model capability discovery unavailable");
                    false
                }
            }
        }
    } else {
        is_responses_only(&requested_model)
    };
    let model = endpoint
        .as_ref()
        .map(|endpoint| endpoint.name.clone())
        .unwrap_or_else(|| requested_model.clone());
    let model_class = endpoint.as_ref().and_then(|endpoint| endpoint.model_class);
    let estimate = state.throttle.estimate(&model, &input);
    let upstream_model = if codex {
        endpoint
            .as_ref()
            .and_then(codex_model_name)
            .unwrap_or_else(|| model.clone())
    } else {
        model.clone()
    };
    input["model"] = Value::String(upstream_model);
    let target = select_request_target(
        state.target,
        client_wire,
        originator,
        &input,
        native_responses,
    );
    let request_body = adapt_request(client_wire, target, input)?;
    let upstream = send_upstream(
        UpstreamControls {
            client: &state.databricks,
            rate_limits: &state.rate_limits,
            throttle: &state.throttle,
        },
        &caller,
        UpstreamRequest {
            model: &model,
            model_class,
            estimate,
            path: upstream_path(target, codex, native_responses),
            headers: upstream_headers(originator),
            body: request_body,
        },
    )
    .await?;
    let UpstreamResult {
        response: upstream,
        throttle,
        upstream_attempt,
    } = upstream;
    let request_log = RequestLogContext::new(
        requested_model,
        model.clone(),
        caller.peer,
        request_bytes,
        started,
        throttle,
        upstream_attempt,
    );
    let status = upstream_status(&upstream)?;
    if status.is_success() && streaming {
        let response_headers = forwarded_response_headers(upstream.headers());
        request_log.stream_connected(client_wire, target, status);
        return stream_response(
            client_wire,
            target,
            upstream,
            model.clone(),
            response_headers,
            StreamLogContext {
                client_wire,
                target,
                request: request_log,
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

fn response_usage(body: &[u8]) -> ResponseTokenUsage {
    serde_json::from_slice::<Value>(body)
        .map(|output| response_token_usage(&output))
        .unwrap_or_default()
}

async fn send_upstream(
    controls: UpstreamControls<'_>,
    caller: &RequestCaller,
    request: UpstreamRequest<'_>,
) -> Result<UpstreamResult, ProxyError> {
    let UpstreamControls {
        client,
        rate_limits,
        throttle,
    } = controls;
    let UpstreamRequest {
        model,
        model_class,
        estimate,
        path,
        headers,
        body,
    } = request;
    let policy = rate_limits.policy();
    let mut backoff = policy.backoff();
    let mut retries = 0;
    loop {
        let upstream_attempt = retries + 1;
        let permit = if policy.max_retries == 0 {
            None
        } else {
            Some(
                rate_limits
                    .acquire(client.host(), &caller.principal, model)
                    .await,
            )
        };
        let admission = match throttle.acquire(model, model_class, estimate).await {
            Ok(admission) => admission,
            Err(error) => {
                if let Some(permit) = permit.as_ref() {
                    rate_limits.completed(permit).await;
                }
                tracing::warn!(
                    host = client.host(),
                    model,
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
                    model: model.to_owned(),
                    estimated_input_tokens: error.estimated_input_tokens,
                    input_limit: error.input_limit,
                });
            }
        };
        if retries > 0 && admission.active {
            throttle.record_retry_reacquisition();
        }
        let response = match client
            .request_builder(path, Method::POST)?
            .headers(headers.clone())
            .body(body.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                admission.release().await;
                if let Some(permit) = permit.as_ref() {
                    rate_limits.completed(permit).await;
                }
                return Err(DatabricksClientError::from(error).into());
            }
        };
        if response.status() != StatusCode::TOO_MANY_REQUESTS {
            if let Some(permit) = permit.as_ref() {
                rate_limits.completed(permit).await;
            }
            return Ok(UpstreamResult {
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
        if input_token_limit && admission.active {
            throttle.record_input_429_after_admission();
        }
        admission.release().await;
        activate_token_throttle(throttle, client, model, &details).await;
        let exhausted = retries >= policy.max_retries;
        if exhausted {
            if let Some(permit) = permit.as_ref() {
                rate_limits.completed(permit).await;
            }
            log_rate_limit(RetryLog {
                client,
                caller,
                model,
                upstream_attempt,
                retry: retries,
                policy,
                delay: std::time::Duration::ZERO,
                delay_source: "exhausted",
                admission: &admission,
                details: &details,
            });
            return Ok(UpstreamResult {
                response,
                throttle: admission,
                upstream_attempt,
            });
        }
        let server_delay = server_retry_after(response.headers(), &details);
        let (delay, delay_source) = if let Some((delay, _)) = server_delay {
            (delay, "retry-after")
        } else if input_token_limit {
            match throttle
                .token_window_delay(model, model_class, estimate)
                .await
            {
                Some(delay) => (delay, "token-window"),
                None => {
                    throttle.record_fallback_window_delay();
                    (std::time::Duration::from_secs(60), "token-window-fallback")
                }
            }
        } else {
            (
                backoff
                    .next()
                    .unwrap_or(policy.max_delay)
                    .min(policy.max_delay),
                "backoff",
            )
        };
        if let Some(permit) = permit.as_ref() {
            rate_limits.rejected(permit, delay).await;
        } else {
            tokio::time::sleep(delay).await;
        }
        log_rate_limit(RetryLog {
            client,
            caller,
            model,
            upstream_attempt,
            retry: retries + 1,
            policy,
            delay,
            delay_source,
            admission: &admission,
            details: &details,
        });
        retries += 1;
        drop(response);
    }
}

/// Activate auto TPM admission once Databricks reports an input-token limit.
async fn activate_token_throttle(
    throttle: &RequestThrottle,
    client: &DatabricksClient,
    model: &str,
    details: &RateLimitDetails,
) {
    if throttle
        .activate_from_message(model, details.message.as_deref())
        .await
    {
        tracing::info!(
            host = client.host(),
            model,
            "model token rate limiting activated"
        );
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
        token_reservation_input = log.admission.reserved_input_tokens,
        token_window_used_before = log.admission.input_window_used_before,
        token_window_wait_ms = log.admission.wait.as_millis(),
        oversized_request = false,
        client_ip = %log.caller.peer.ip(),
        client_port = log.caller.peer.port(),
        exhausted,
        "model request rate limited"
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
        });
        let throttle = RequestThrottle::new(
            "host",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: crate::throttle::RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );
        let caller = test_caller();

        let response = tokio::time::timeout(
            Duration::from_millis(900),
            send_upstream(
                UpstreamControls {
                    client: &client,
                    rate_limits: &gate,
                    throttle: &throttle,
                },
                &caller,
                UpstreamRequest {
                    model: "model",
                    model_class: None,
                    estimate: TokenEstimate {
                        input: 1,
                        output: 0,
                    },
                    path: "/test",
                    headers: upstream_headers(None),
                    body: br#"{"model":"model"}"#.to_vec(),
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::OK);
        assert_eq!(response.upstream_attempt, 2);
        let counters = throttle.counters();
        assert_eq!(counters.automatic_activations, 1);
        assert_eq!(counters.retry_reacquisitions, 1);
        assert!(
            !throttle
                .activate_from_message("model", Some("Exceeded workspace input tokens per minute"))
                .await
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

        let response = send_upstream(
            UpstreamControls {
                client: &client,
                rate_limits: &gate,
                throttle: &throttle,
            },
            &caller,
            UpstreamRequest {
                model: "model",
                model_class: None,
                estimate: TokenEstimate {
                    input: 1,
                    output: 0,
                },
                path: "/test",
                headers: upstream_headers(None),
                body: Vec::new(),
            },
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

        let response = send_upstream(
            UpstreamControls {
                client: &client,
                rate_limits: &gate,
                throttle: &throttle,
            },
            &caller,
            UpstreamRequest {
                model: "model",
                model_class: None,
                estimate: TokenEstimate {
                    input: 1,
                    output: 0,
                },
                path: "/test",
                headers: upstream_headers(None),
                body: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.upstream_attempt, 3);
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

        let error = send_upstream(
            UpstreamControls {
                client: &client,
                rate_limits: &gate,
                throttle: &throttle,
            },
            &caller,
            UpstreamRequest {
                model: "model",
                model_class: None,
                estimate: TokenEstimate {
                    input: 101,
                    output: 0,
                },
                path: "/test",
                headers: upstream_headers(None),
                body: Vec::new(),
            },
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
        assert_eq!(throttle.counters().oversized_rejections, 1);
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
