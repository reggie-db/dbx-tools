//! Contained prototype for adapting OpenAI and Anthropic clients to Databricks.

use std::{
    io,
    net::IpAddr,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use aigw_anthropic::{
    translate::{
        chat_response_to_messages, messages_request_to_canonical, stream_event_to_anthropic_sse,
        NativeSseContext,
    },
    types::MessagesRequest,
};
use aigw_core::{
    model::{ChatRequest, ChatResponse, StreamEvent},
    translate::{ResponseTranslator, StreamParser},
};
use aigw_openai::{
    build_responses_create_request, OpenAIResponseTranslator, ResponsesRequestConfig,
    ResponsesResponseTranslator,
};
use async_trait::async_trait;
use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, ValueEnum};
use dbx_tools_databricks::{
    create_persistent_auth, init_logging, DatabricksAuthOptions, PersistentAuth,
};
use dbx_tools_model::{codex_model_name, models_payload, ModelClient};
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::info;

const CHAT_PATH: &str = "serving-endpoints/chat/completions";
const CODEX_RESPONSES_PATH: &str = "ai-gateway/codex/v1/responses";
const OPEN_RESPONSES_PATH: &str = "serving-endpoints/open-responses";
const ORIGINATOR_HEADER: &str = "originator";
const RESPONSES_PATH: &str = "serving-endpoints/responses";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClientWire {
    Chat,
    Responses,
    Anthropic,
}

/// Databricks output protocol selected for requests.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum TargetWire {
    Auto,
    Chat,
    Responses,
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    host: String,
    models: ModelClient,
    target: TargetWire,
    tokens: Arc<dyn TokenSource>,
}

#[derive(Debug, Default, Deserialize)]
struct ModelsQuery {
    #[serde(default)]
    extended: bool,
    search: Option<String>,
}

#[async_trait]
trait TokenSource: Send + Sync {
    async fn token(&self) -> Result<String, ProxyError>;
    async fn refresh_rejected(&self, stale: &str) -> Result<String, ProxyError>;
}

struct DatabricksTokenSource {
    auth: Arc<PersistentAuth>,
}

impl DatabricksTokenSource {
    async fn create(profile: Option<String>) -> Result<(String, Arc<Self>), ProxyError> {
        let auth = create_persistent_auth(
            DatabricksAuthOptions {
                profile,
                prefer_user_to_machine: false,
                ..Default::default()
            },
            None,
        )
        .await
        .map_err(|error| ProxyError::Auth(error.to_string()))?;
        let host = auth.status().host.trim_end_matches('/').to_owned();
        Ok((host, Arc::new(Self { auth })))
    }
}

#[async_trait]
impl TokenSource for DatabricksTokenSource {
    async fn token(&self) -> Result<String, ProxyError> {
        let token = self
            .auth
            .token(Some(false))
            .await
            .map_err(|error| ProxyError::Auth(error.to_string()))?;
        Ok(format!("{} {}", token.token_type, token.access_token))
    }

    async fn refresh_rejected(&self, stale: &str) -> Result<String, ProxyError> {
        let token = self
            .auth
            .refresh_rejected_token(stale.to_owned())
            .await
            .map_err(|error| ProxyError::Auth(error.to_string()))?;
        Ok(format!("{} {}", token.token_type, token.access_token))
    }
}

#[derive(Debug, Parser)]
#[command(name = "dbx-model-proxy", version)]
struct Cli {
    /// Databricks CLI profile.
    #[arg(long, env = "DATABRICKS_CONFIG_PROFILE")]
    profile: Option<String>,
    /// Listening address.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    /// Listening port.
    #[arg(long, env = "DATABRICKS_APP_PORT", default_value_t = 4000)]
    port: u16,
    /// Databricks output protocol.
    #[arg(long, value_enum, default_value_t = TargetWire::Auto)]
    target: TargetWire,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging()?;
    let Cli {
        profile,
        host,
        port,
        target,
    } = Cli::parse();
    let (databricks_host, tokens) = DatabricksTokenSource::create(profile).await?;
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    let models = ModelClient::new(&databricks_host)?;
    let state = AppState {
        client: reqwest::Client::new(),
        host: databricks_host,
        models,
        target,
        tokens,
    };
    info!(address = %listener.local_addr()?, ?target, "model proxy listening");
    axum::serve(listener, routes(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn routes(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/v1/models", get(list_models))
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
        .with_state(state)
}

async fn list_models(
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ProxyError> {
    let started = Instant::now();
    let originator = request_originator(&headers);
    let codex = originator.is_some_and(is_codex_originator);
    let token = state.tokens.token().await?;
    let endpoints = state.models.models(&token, false).await?;
    let payload = models_payload(&endpoints, query.search.as_deref(), query.extended, codex);
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

async fn proxy(
    state: AppState,
    client_wire: ClientWire,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let mut input: Value = serde_json::from_slice(&body)?;
    let requested_model = input
        .get("model")
        .and_then(Value::as_str)
        .ok_or(ProxyError::MissingModel)?
        .to_owned();
    let streaming = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let originator = request_originator(&headers);
    let codex = originator.is_some_and(is_codex_originator);
    let token = state.tokens.token().await?;
    let endpoint = state
        .models
        .resolve_endpoint(&token, &requested_model)
        .await?;
    let model = endpoint
        .as_ref()
        .map(|endpoint| endpoint.name.clone())
        .unwrap_or_else(|| requested_model.clone());
    let upstream_model = if codex {
        endpoint
            .as_ref()
            .and_then(codex_model_name)
            .unwrap_or_else(|| model.clone())
    } else {
        model.clone()
    };
    input["model"] = Value::String(upstream_model);
    let target = select_request_target(state.target, client_wire, &model, originator);
    let request_body = adapt_request(client_wire, target, input)?;
    let url = upstream_url(&state.host, target, &model, codex);
    let mut upstream = send(&state.client, &url, &token, originator, &request_body).await?;

    if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
        let stale = token
            .split_once(' ')
            .map(|(_, value)| value)
            .unwrap_or(token.as_str());
        let refreshed = state.tokens.refresh_rejected(stale).await?;
        upstream = send(&state.client, &url, &refreshed, originator, &request_body).await?;
    }

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .map_err(|error| ProxyError::Upstream(error.to_string()))?;
    if status.is_success() && streaming {
        info!(
            ?client_wire,
            ?target,
            requested_model,
            resolved_model = model,
            streaming,
            status = status.as_u16(),
            latency_ms = started.elapsed().as_millis(),
            "model stream connected"
        );
        return stream_response(client_wire, target, upstream, model);
    }
    let response_body = upstream
        .bytes()
        .await
        .map_err(|error| ProxyError::Upstream(error.to_string()))?;
    if !status.is_success() {
        info!(
            ?client_wire,
            ?target,
            requested_model,
            resolved_model = model,
            streaming,
            status = status.as_u16(),
            latency_ms = started.elapsed().as_millis(),
            "model request completed"
        );
        return Ok((status, response_body).into_response());
    }

    let output = adapt_response(client_wire, target, status, &response_body)?;
    info!(
        ?client_wire,
        ?target,
        requested_model,
        resolved_model = model,
        streaming,
        status = status.as_u16(),
        latency_ms = started.elapsed().as_millis(),
        "model request completed"
    );
    Ok((status, [(header::CONTENT_TYPE, "application/json")], output).into_response())
}

fn stream_response(
    client_wire: ClientWire,
    target: TargetWire,
    upstream: reqwest::Response,
    model: String,
) -> Result<Response, ProxyError> {
    // Preserve native SSE framing when no protocol translation is required.
    if matches!(
        (client_wire, target),
        (ClientWire::Chat, TargetWire::Chat) | (ClientWire::Responses, TargetWire::Responses)
    ) {
        let body = Body::from_stream(
            upstream
                .bytes_stream()
                .map_err(|error| io::Error::other(error.to_string())),
        );
        return Ok(sse_response(body));
    }

    let mut parser: Box<dyn StreamParser> = match target {
        TargetWire::Chat => OpenAIResponseTranslator.stream_parser(),
        TargetWire::Responses => ResponsesResponseTranslator.stream_parser(),
        TargetWire::Auto => unreachable!("auto target is resolved before streaming"),
    };
    let mut events = upstream.bytes_stream().eventsource();
    let stream = async_stream::stream! {
        let mut anthropic = NativeSseContext::with_pinned_model(model.clone());
        let mut chat = ChatSseContext::new(model);
        let mut failed = false;

        while let Some(event) = events.next().await {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    yield Ok::<Bytes, io::Error>(stream_error(client_wire, &error.to_string()));
                    failed = true;
                    break;
                }
            };
            let parsed = match parser.parse_event(&event.event, &event.data) {
                Ok(parsed) => parsed,
                Err(error) => {
                    yield Ok(stream_error(client_wire, &error.to_string()));
                    failed = true;
                    break;
                }
            };
            for canonical in parsed {
                for frame in encode_stream_event(
                    client_wire,
                    &mut anthropic,
                    &mut chat,
                    canonical,
                ) {
                    yield Ok(frame);
                }
            }
        }
        if !failed {
            // Parsers can buffer terminal usage or completion events until EOF.
            match parser.finish() {
                Ok(parsed) => {
                    for canonical in parsed {
                        for frame in encode_stream_event(
                            client_wire,
                            &mut anthropic,
                            &mut chat,
                            canonical,
                        ) {
                            yield Ok(frame);
                        }
                    }
                }
                Err(error) => {
                    yield Ok(stream_error(client_wire, &error.to_string()));
                }
            }
        }
    };
    Ok(sse_response(Body::from_stream(stream)))
}

fn sse_response(body: Body) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

fn encode_stream_event(
    client_wire: ClientWire,
    anthropic: &mut NativeSseContext,
    chat: &mut ChatSseContext,
    event: StreamEvent,
) -> Vec<Bytes> {
    match client_wire {
        ClientWire::Anthropic => stream_event_to_anthropic_sse(&event, anthropic)
            .into_iter()
            .map(|frame| Bytes::from(frame.to_sse_bytes()))
            .collect(),
        ClientWire::Chat => chat.encode(event).into_iter().map(Bytes::from).collect(),
        ClientWire::Responses => Vec::new(),
    }
}

fn stream_error(client_wire: ClientWire, message: &str) -> Bytes {
    let payload = match client_wire {
        ClientWire::Anthropic => json!({
            "type": "error",
            "error": {"type": "api_error", "message": message}
        }),
        _ => json!({"error": {"type": "proxy_error", "message": message}}),
    };
    Bytes::from(format!("event: error\ndata: {payload}\n\n"))
}

struct ChatSseContext {
    created: u64,
    id: String,
    model: String,
}

impl ChatSseContext {
    fn new(model: String) -> Self {
        let created = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            created,
            id: format!("chatcmpl-proxy-{created}"),
            model,
        }
    }

    fn encode(&mut self, event: StreamEvent) -> Vec<String> {
        let frame = match event {
            StreamEvent::ResponseMeta { id, model } => {
                if !id.is_empty() {
                    self.id = id;
                }
                if !model.is_empty() {
                    self.model = model;
                }
                Some(self.chunk(json!({"role": "assistant"}), Value::Null, None))
            }
            StreamEvent::ContentDelta(text) => {
                Some(self.chunk(json!({"content": text}), Value::Null, None))
            }
            StreamEvent::ReasoningDelta(text) => {
                Some(self.chunk(json!({"reasoning_content": text}), Value::Null, None))
            }
            StreamEvent::ToolCallStart {
                index, id, name, ..
            } => Some(self.chunk(
                json!({
                    "tool_calls": [{
                        "index": index,
                        "id": id,
                        "type": "function",
                        "function": {"name": name, "arguments": ""}
                    }]
                }),
                Value::Null,
                None,
            )),
            StreamEvent::ToolCallDelta {
                index, arguments, ..
            } => Some(self.chunk(
                json!({
                    "tool_calls": [{
                        "index": index,
                        "function": {"arguments": arguments}
                    }]
                }),
                Value::Null,
                None,
            )),
            StreamEvent::Finish(reason) => Some(self.chunk(json!({}), json!(reason), None)),
            StreamEvent::Usage(usage) => {
                Some(self.chunk(json!({}), Value::Null, Some(json!(usage))))
            }
            StreamEvent::Done => return vec!["data: [DONE]\n\n".to_owned()],
            _ => None,
        };
        frame.into_iter().collect()
    }

    fn chunk(&self, delta: Value, finish_reason: Value, usage: Option<Value>) -> String {
        let mut payload = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason
            }]
        });
        if let Some(usage) = usage {
            payload["usage"] = usage;
        }
        format!("data: {payload}\n\n")
    }
}

async fn send(
    client: &reqwest::Client,
    url: &str,
    authorization: &str,
    originator: Option<&str>,
    body: &[u8],
) -> Result<reqwest::Response, ProxyError> {
    let mut request = client
        .post(url)
        .header(header::AUTHORIZATION, authorization)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_vec());
    if let Some(originator) = originator.filter(|value| is_codex_originator(value)) {
        request = request.header(ORIGINATOR_HEADER, originator);
    }
    request
        .send()
        .await
        .map_err(|error| ProxyError::Upstream(error.to_string()))
}

fn select_target(configured: TargetWire, client: ClientWire, model: &str) -> TargetWire {
    match configured {
        TargetWire::Auto if client == ClientWire::Responses || responses_only(model) => {
            TargetWire::Responses
        }
        TargetWire::Auto => TargetWire::Chat,
        target => target,
    }
}

fn select_request_target(
    configured: TargetWire,
    client: ClientWire,
    model: &str,
    originator: Option<&str>,
) -> TargetWire {
    let configured = if originator.is_some_and(is_codex_originator) {
        TargetWire::Responses
    } else {
        configured
    };
    select_target(configured, client, model)
}

fn adapt_request(
    client: ClientWire,
    target: TargetWire,
    input: Value,
) -> Result<Vec<u8>, ProxyError> {
    if client == ClientWire::Responses {
        return match target {
            TargetWire::Responses => serde_json::to_vec(&input).map_err(Into::into),
            _ => Err(ProxyError::Unsupported(
                "Responses input can currently target only Responses".to_owned(),
            )),
        };
    }

    let canonical = match client {
        ClientWire::Chat => serde_json::from_value::<ChatRequest>(input)?,
        ClientWire::Anthropic => {
            messages_request_to_canonical(serde_json::from_value::<MessagesRequest>(input)?)
                .map_err(|error| ProxyError::Translation(error.to_string()))?
        }
        ClientWire::Responses => unreachable!(),
    };
    match target {
        TargetWire::Chat => serde_json::to_vec(&canonical).map_err(Into::into),
        TargetWire::Responses => {
            let request =
                build_responses_create_request(&canonical, &ResponsesRequestConfig::default())
                    .map_err(|error| ProxyError::Translation(error.to_string()))?;
            serde_json::to_vec(&request).map_err(Into::into)
        }
        TargetWire::Auto => unreachable!(),
    }
}

fn adapt_response(
    client: ClientWire,
    target: TargetWire,
    status: StatusCode,
    body: &[u8],
) -> Result<Vec<u8>, ProxyError> {
    if client == ClientWire::Responses && target == TargetWire::Responses {
        return Ok(body.to_vec());
    }
    let canonical: ChatResponse = match target {
        TargetWire::Chat => OpenAIResponseTranslator
            .translate_response(status, body)
            .map_err(|error| ProxyError::Translation(error.to_string()))?,
        TargetWire::Responses => ResponsesResponseTranslator
            .translate_response(status, body)
            .map_err(|error| ProxyError::Translation(error.to_string()))?,
        TargetWire::Auto => unreachable!(),
    };
    match client {
        ClientWire::Chat => serde_json::to_vec(&canonical).map_err(Into::into),
        ClientWire::Anthropic => serde_json::to_vec(
            &chat_response_to_messages(canonical)
                .map_err(|error| ProxyError::Translation(error.to_string()))?,
        )
        .map_err(Into::into),
        ClientWire::Responses => Err(ProxyError::Unsupported(
            "Chat output cannot currently be encoded as Responses".to_owned(),
        )),
    }
}

fn upstream_url(host: &str, target: TargetWire, model: &str, codex: bool) -> String {
    let path = match (target, codex) {
        (TargetWire::Responses, true) => CODEX_RESPONSES_PATH,
        (TargetWire::Chat, _) => CHAT_PATH,
        (TargetWire::Responses, false) if openai_family(model) => RESPONSES_PATH,
        (TargetWire::Responses, false) => OPEN_RESPONSES_PATH,
        (TargetWire::Auto, _) => unreachable!(),
    };
    format!("{}/{path}", host.trim_end_matches('/'))
}

fn request_originator(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(ORIGINATOR_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_codex_originator(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("codex")
}

fn openai_family(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("gpt")
        || model.contains("codex")
        || model.contains("openai")
        || (1..=9).any(|version| model.contains(&format!("o{version}")))
}

fn responses_only(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    if model.contains("codex") {
        return true;
    }
    let Some(gpt) = model.find("gpt") else {
        return false;
    };
    let numbers: Vec<u32> = model[gpt + 3..]
        .trim_start_matches(['-', '_', '.', '/'])
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.parse().ok())
        .collect();
    matches!(numbers.as_slice(), [major, ..] if *major > 5)
        || matches!(numbers.as_slice(), [5, minor, ..] if *minor >= 4)
}

#[derive(Debug, thiserror::Error)]
enum ProxyError {
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("request body must include a string model")]
    MissingModel,
    #[error("upstream request failed: {0}")]
    Upstream(String),
    #[error("protocol translation failed: {0}")]
    Translation(String),
    #[error("unsupported protocol route: {0}")]
    Unsupported(String),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("model resolution failed: {0}")]
    Model(#[from] dbx_tools_model::ModelError),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::MissingModel | Self::Json(_) | Self::Unsupported(_) => StatusCode::BAD_REQUEST,
            Self::Auth(_) => StatusCode::UNAUTHORIZED,
            Self::Upstream(_) | Self::Translation(_) | Self::Model(_) => StatusCode::BAD_GATEWAY,
        };
        (
            status,
            Json(json!({
                "error": {"message": self.to_string(), "type": "proxy_error"}
            })),
        )
            .into_response()
    }
}

async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aigw_core::model::{FinishReason, Usage};

    #[test]
    fn openai_chat_adapts_to_responses() {
        let output = adapt_request(
            ClientWire::Chat,
            TargetWire::Responses,
            json!({
                "model": "databricks-gpt-5-4",
                "messages": [
                    {"role": "system", "content": "Be concise"},
                    {"role": "user", "content": "Hello"}
                ],
                "tools": [{
                    "type": "function",
                    "function": {"name": "lookup", "parameters": {"type": "object"}}
                }]
            }),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["instructions"], "Be concise");
        assert_eq!(value["input"][0]["role"], "user");
        assert_eq!(value["tools"][0]["name"], "lookup");
    }

    #[test]
    fn anthropic_messages_adapt_to_responses() {
        let output = adapt_request(
            ClientWire::Anthropic,
            TargetWire::Responses,
            json!({
                "model": "claude-sonnet-4-6",
                "max_tokens": 100,
                "system": "Use tools",
                "messages": [{"role": "user", "content": "Hello"}],
                "tools": [{
                    "name": "lookup",
                    "description": "Look up a value",
                    "input_schema": {"type": "object"}
                }]
            }),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["instructions"], "Use tools");
        assert_eq!(value["input"][0]["role"], "user");
        assert_eq!(value["tools"][0]["name"], "lookup");
    }

    #[test]
    fn canonical_events_encode_as_chat_completion_chunks() {
        let mut context = ChatSseContext::new("requested-model".to_owned());
        let frames = [
            StreamEvent::ResponseMeta {
                id: "response-id".to_owned(),
                model: "upstream-model".to_owned(),
            },
            StreamEvent::ContentDelta("Hello".to_owned()),
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call-1".to_owned(),
                name: "lookup".to_owned(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments: r#"{"key":"value"}"#.to_owned(),
            },
            StreamEvent::Finish(FinishReason::ToolCalls),
            StreamEvent::Usage(Usage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
                ..Default::default()
            }),
            StreamEvent::Done,
        ]
        .into_iter()
        .flat_map(|event| context.encode(event))
        .collect::<Vec<_>>();

        assert!(frames[0].contains(r#""role":"assistant""#));
        assert!(frames[1].contains(r#""content":"Hello""#));
        assert!(frames[2].contains(r#""name":"lookup""#));
        assert!(frames[3].contains(r#""arguments":"{\"key\":\"value\"}""#));
        assert!(frames[4].contains(r#""finish_reason":"tool_calls""#));
        assert!(frames[5].contains(r#""total_tokens":8"#));
        assert_eq!(frames[6], "data: [DONE]\n\n");
    }

    #[test]
    fn responses_stream_adapts_to_chat_completion_chunks() {
        let mut parser = ResponsesResponseTranslator.stream_parser();
        let mut context = ChatSseContext::new("requested-model".to_owned());
        let frames = [
            r#"{"type":"response.created","response":{"id":"resp-1","model":"gpt-5.4"}}"#,
            r#"{"type":"response.output_text.delta","delta":"Hello"}"#,
            r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}"#,
        ]
        .into_iter()
        .flat_map(|data| parser.parse_event("", data).unwrap())
        .flat_map(|event| context.encode(event))
        .collect::<Vec<_>>();

        assert!(frames[0].contains(r#""id":"resp-1""#));
        assert!(frames[1].contains(r#""content":"Hello""#));
        assert!(frames[2].contains(r#""finish_reason":"stop""#));
        assert!(frames[3].contains(r#""total_tokens":3"#));
        assert_eq!(frames[4], "data: [DONE]\n\n");
    }

    #[test]
    fn auto_selects_responses_for_responses_only_models() {
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Chat, "codex-mini"),
            TargetWire::Responses
        );
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Chat, "databricks-gpt-5-4"),
            TargetWire::Responses
        );
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Chat, "claude-sonnet-4-6"),
            TargetWire::Chat
        );
    }

    #[test]
    fn codex_originator_uses_codex_responses_route_without_model_filtering() {
        assert!(is_codex_originator(" Codex_CLI_RS "));
        assert_eq!(
            select_request_target(
                TargetWire::Auto,
                ClientWire::Chat,
                "custom-model",
                Some("codex_cli_rs"),
            ),
            TargetWire::Responses
        );
        assert_eq!(
            upstream_url(
                "https://workspace.example.com",
                TargetWire::Responses,
                "custom-model",
                true,
            ),
            "https://workspace.example.com/ai-gateway/codex/v1/responses"
        );
    }
}
