//! HTTP routes for model listing, generation, and embeddings.

use std::{
    num::{NonZeroU64, NonZeroUsize},
    time::Instant,
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
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
    stream::stream_response,
    throttle::RequestThrottle,
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
        tokens_per_minute: Option<NonZeroU64>,
        image_resize_threshold_bytes: usize,
        rate_limit_policy: RateLimitPolicy,
    ) -> Self {
        let throttle = RequestThrottle::new(databricks.host(), tokens_per_minute);
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

pub(crate) fn routes(state: AppState, max_request_bytes: NonZeroUsize) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/models", get(list_models))
        .route("/v1/embeddings", post(embeddings))
        .route(
            "/v1/chat/completions",
            post(
                |State(state): State<AppState>, headers: HeaderMap, body: Bytes| async move {
                    proxy(state, ClientWire::Chat, headers, body).await
                },
            ),
        )
        .route(
            "/v1/responses",
            post(
                |State(state): State<AppState>, headers: HeaderMap, body: Bytes| async move {
                    proxy(state, ClientWire::Responses, headers, body).await
                },
            ),
        )
        .route(
            "/v1/messages",
            post(
                |State(state): State<AppState>, headers: HeaderMap, body: Bytes| async move {
                    proxy(state, ClientWire::Anthropic, headers, body).await
                },
            ),
        )
        .layer(DefaultBodyLimit::max(max_request_bytes.get()))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}

async fn list_models(
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
        latency_ms = started.elapsed().as_millis(),
        "model request completed"
    );
    Ok(Json(payload))
}

async fn embeddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let input: Value = serde_json::from_slice(&body)?;
    let requested_model = requested_model(&input)?.to_owned();
    let endpoint = state
        .models
        .resolve_serving_endpoint_for_class(&requested_model, ModelClass::Embedding)
        .await?
        .ok_or_else(|| ProxyError::EmbeddingModelNotFound(requested_model.clone()))?;
    let throttle_wait = state.throttle.acquire(&endpoint.name, &input).await;
    let principal = request_principal(&headers, &state.databricks);
    let (path, request_body) = prepare_embedding_request(input, &endpoint.name)?;
    let originator = request_originator(&headers);
    let upstream = send_upstream(
        &state.databricks,
        &state.rate_limits,
        &principal,
        &endpoint.name,
        &path,
        upstream_headers(originator),
        request_body,
    )
    .await?;
    let upstream = buffered_response(upstream).await?;
    info!(
        route = "/v1/embeddings",
        requested_model,
        resolved_model = endpoint.name,
        status = upstream.status.as_u16(),
        throttle_wait_ms = throttle_wait.as_millis(),
        latency_ms = started.elapsed().as_millis(),
        "embedding request completed"
    );
    Ok(upstream.into_raw_response())
}

async fn proxy(
    state: AppState,
    client_wire: ClientWire,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let mut input: Value = serde_json::from_slice(&body)?;
    normalize_embedded_images(&mut input, state.image_resize_threshold_bytes)?;
    let requested_model = requested_model(&input)?.to_owned();
    let streaming = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let originator = request_originator(&headers);
    let principal = request_principal(&headers, &state.databricks);
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
    let throttle_wait = state.throttle.acquire(&model, &input).await;
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
        &state.databricks,
        &state.rate_limits,
        &principal,
        &model,
        upstream_path(target, codex, native_responses),
        upstream_headers(originator),
        request_body,
    )
    .await?;
    let status = upstream_status(&upstream)?;
    if status.is_success() && streaming {
        let response_headers = forwarded_response_headers(upstream.headers());
        info!(
            ?client_wire,
            ?target,
            requested_model,
            resolved_model = model,
            streaming,
            status = status.as_u16(),
            throttle_wait_ms = throttle_wait.as_millis(),
            latency_ms = started.elapsed().as_millis(),
            "model stream connected"
        );
        return stream_response(client_wire, target, upstream, model, response_headers);
    }
    let upstream = buffered_response(upstream).await?;
    if !upstream.status.is_success() {
        info!(
            ?client_wire,
            ?target,
            requested_model,
            resolved_model = model,
            streaming,
            status = upstream.status.as_u16(),
            throttle_wait_ms = throttle_wait.as_millis(),
            latency_ms = started.elapsed().as_millis(),
            "model request completed"
        );
        return Ok(upstream.into_raw_response());
    }

    let output = adapt_response(client_wire, target, upstream.status, &upstream.body)?;
    info!(
        ?client_wire,
        ?target,
        requested_model,
        resolved_model = model,
        streaming,
        status = upstream.status.as_u16(),
        throttle_wait_ms = throttle_wait.as_millis(),
        latency_ms = started.elapsed().as_millis(),
        "model request completed"
    );
    Ok(upstream.into_json_response(output))
}

async fn send_upstream(
    client: &DatabricksClient,
    rate_limits: &RateLimitGate,
    principal: &str,
    model: &str,
    path: &str,
    headers: HeaderMap,
    body: Vec<u8>,
) -> Result<reqwest::Response, DatabricksClientError> {
    let policy = rate_limits.policy();
    if policy.max_retries == 0 {
        let response = client
            .request_builder(path, Method::POST)?
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(DatabricksClientError::from)?;
        if response.status() != StatusCode::TOO_MANY_REQUESTS {
            return Ok(response);
        }
        let (response, details) = inspect_rate_limit_response(response).await?;
        let (delay, delay_source) = server_retry_after(response.headers(), &details)
            .unwrap_or((std::time::Duration::ZERO, "disabled"));
        log_rate_limit(client, model, 0, policy, delay, delay_source, &details);
        return Ok(response);
    }
    let mut backoff = policy.backoff();
    let mut retries = 0;
    loop {
        let permit = rate_limits.acquire(client.host(), principal, model).await;
        let response = match client
            .request_builder(path, Method::POST)?
            .headers(headers.clone())
            .body(body.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                rate_limits.completed(&permit).await;
                return Err(error.into());
            }
        };
        if response.status() != StatusCode::TOO_MANY_REQUESTS {
            rate_limits.completed(&permit).await;
            return Ok(response);
        }
        let (response, details) = match inspect_rate_limit_response(response).await {
            Ok(inspected) => inspected,
            Err(error) => {
                rate_limits.completed(&permit).await;
                return Err(error);
            }
        };
        let server_delay = server_retry_after(response.headers(), &details);
        let delay_source = server_delay.map_or("backoff", |(_, source)| source);
        let delay = server_delay.map_or_else(
            || {
                backoff
                    .next()
                    .unwrap_or(policy.max_delay)
                    .min(policy.max_delay)
            },
            |(delay, _)| delay,
        );
        rate_limits.rejected(&permit, delay).await;
        let exhausted = retries >= policy.max_retries;
        let retry = if exhausted { retries } else { retries + 1 };
        log_rate_limit(client, model, retry, policy, delay, delay_source, &details);
        if exhausted {
            return Ok(response);
        }
        retries += 1;
        drop(response);
    }
}

/// Log a 429 and any Databricks error message without exposing request payloads.
fn log_rate_limit(
    client: &DatabricksClient,
    model: &str,
    retry: u32,
    policy: RateLimitPolicy,
    delay: std::time::Duration,
    delay_source: &str,
    details: &RateLimitDetails,
) {
    let exhausted = retry >= policy.max_retries;
    tracing::warn!(
        host = client.host(),
        model,
        retry,
        max_retries = policy.max_retries,
        delay_ms = delay.as_millis(),
        delay_source,
        rate_limit_message = details.message.as_deref().unwrap_or_default(),
        exhausted,
        "model request rate limited; pausing profile-model key"
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
                        "message": "Rate limit exceeded",
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

        let response = tokio::time::timeout(
            Duration::from_millis(900),
            send_upstream(
                &client,
                &gate,
                "principal",
                "model",
                "/test",
                upstream_headers(None),
                br#"{"model":"model"}"#.to_vec(),
            ),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
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

        let response = send_upstream(
            &client,
            &gate,
            "principal",
            "model",
            "/test",
            upstream_headers(None),
            Vec::new(),
        )
        .await
        .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.bytes().await.unwrap(),
            br#"{"error":{"message":"quota exhausted"}}"#.as_slice()
        );
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
