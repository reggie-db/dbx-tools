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
use dbx_tools_model::{
    codex_model_name, models_payload_with_capabilities, ModelCapabilitiesResolver, ModelClient,
};
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
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
    capabilities: ModelCapabilitiesResolver,
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
        capabilities: ModelCapabilitiesResolver::new()?,
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
    let native_responses = if let Some(endpoint) = endpoint.as_ref() {
        match state.capabilities.capabilities().await {
            Ok(capabilities) => capabilities.supports_responses(endpoint),
            Err(error) => {
                tracing::warn!(%error, "model capability discovery unavailable");
                false
            }
        }
    } else {
        false
    };
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
    let target = select_request_target(
        state.target,
        client_wire,
        originator,
        &input,
        native_responses,
    );
    let request_body = adapt_request(client_wire, target, input)?;
    let url = upstream_url(&state.host, target, codex, native_responses);
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

fn select_target(configured: TargetWire, client: ClientWire, native_responses: bool) -> TargetWire {
    match configured {
        TargetWire::Auto if client == ClientWire::Responses || native_responses => {
            TargetWire::Responses
        }
        TargetWire::Auto => TargetWire::Chat,
        target => target,
    }
}

fn select_request_target(
    configured: TargetWire,
    client: ClientWire,
    originator: Option<&str>,
    input: &Value,
    native_responses: bool,
) -> TargetWire {
    let configured = if originator.is_some_and(is_codex_originator) {
        TargetWire::Responses
    } else if configured == TargetWire::Auto && request_requires_responses(client, input) {
        TargetWire::Responses
    } else {
        configured
    };
    select_target(configured, client, native_responses)
}

fn adapt_request(
    client: ClientWire,
    target: TargetWire,
    mut input: Value,
) -> Result<Vec<u8>, ProxyError> {
    if client == ClientWire::Responses {
        return match target {
            TargetWire::Responses => serde_json::to_vec(&input).map_err(Into::into),
            _ => Err(ProxyError::Unsupported(
                "Responses input can currently target only Responses".to_owned(),
            )),
        };
    }

    if target == TargetWire::Chat && request_requires_responses(client, &input) {
        return Err(ProxyError::Unsupported(
            "request uses Responses-only tools or fields but the proxy target is Chat".to_owned(),
        ));
    }

    let original_input = input.clone();
    let original_tools = take_cross_protocol_tools(client, &mut input);

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
            let mut request = serde_json::to_value(request)?;
            preserve_responses_fields(&original_input, &mut request);
            if let Some(tools) = original_tools {
                request["tools"] = Value::Array(translate_responses_tools(client, tools)?);
            }
            serde_json::to_vec(&request).map_err(Into::into)
        }
        TargetWire::Auto => unreachable!(),
    }
}

fn request_requires_responses(client: ClientWire, input: &Value) -> bool {
    if client == ClientWire::Responses {
        return true;
    }
    let has_hosted_tool = input
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind != "function")
            })
        });
    has_hosted_tool
        || [
            "background",
            "conversation",
            "context_management",
            "previous_response_id",
            "prompt_cache_key",
            "prompt_cache_retention",
            "safety_identifier",
            "stream_options",
            "truncation",
        ]
        .iter()
        .any(|field| input.get(*field).is_some())
}

fn take_cross_protocol_tools(client: ClientWire, input: &mut Value) -> Option<Vec<Value>> {
    let tools = input.get("tools")?.as_array()?.clone();
    let canonical = tools
        .iter()
        .filter(|tool| match client {
            ClientWire::Chat => tool.get("type").and_then(Value::as_str) == Some("function"),
            ClientWire::Anthropic => tool.get("input_schema").is_some(),
            ClientWire::Responses => false,
        })
        .cloned()
        .collect::<Vec<_>>();
    if canonical.is_empty() {
        input
            .as_object_mut()
            .expect("request is an object")
            .remove("tools");
    } else {
        input["tools"] = Value::Array(canonical);
    }
    Some(tools)
}

fn translate_responses_tools(
    client: ClientWire,
    tools: Vec<Value>,
) -> Result<Vec<Value>, ProxyError> {
    tools
        .into_iter()
        .map(|tool| match client {
            ClientWire::Chat => translate_chat_tool(tool),
            ClientWire::Anthropic => translate_anthropic_tool(tool),
            ClientWire::Responses => Ok(tool),
        })
        .collect()
}

fn translate_chat_tool(tool: Value) -> Result<Value, ProxyError> {
    let mut tool = tool
        .as_object()
        .cloned()
        .ok_or_else(|| ProxyError::Unsupported("Chat tools must be JSON objects".to_owned()))?;
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function");
    if kind != "function" {
        normalize_web_search_tool(&mut tool);
        return Ok(Value::Object(tool));
    }
    let function = tool
        .remove("function")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| {
            ProxyError::Unsupported("function tools must include a function object".to_owned())
        })?;
    tool.insert("type".to_owned(), Value::String("function".to_owned()));
    tool.extend(function);
    Ok(Value::Object(tool))
}

fn translate_anthropic_tool(tool: Value) -> Result<Value, ProxyError> {
    let mut tool = tool.as_object().cloned().ok_or_else(|| {
        ProxyError::Unsupported("Anthropic tools must be JSON objects".to_owned())
    })?;
    if let Some(parameters) = tool.remove("input_schema") {
        tool.insert("type".to_owned(), Value::String("function".to_owned()));
        tool.insert("parameters".to_owned(), parameters);
        tool.remove("cache_control");
    } else {
        normalize_web_search_tool(&mut tool);
    }
    Ok(Value::Object(tool))
}

fn normalize_web_search_tool(tool: &mut Map<String, Value>) {
    let legacy = tool
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("web_search"));
    if legacy {
        tool.insert("type".to_owned(), Value::String("web_search".to_owned()));
        tool.remove("name");
    }
}

fn preserve_responses_fields(input: &Value, output: &mut Value) {
    let output = output
        .as_object_mut()
        .expect("Responses request is an object");
    for field in [
        "background",
        "conversation",
        "context_management",
        "metadata",
        "previous_response_id",
        "prompt_cache_key",
        "prompt_cache_retention",
        "safety_identifier",
        "service_tier",
        "stream_options",
        "truncation",
    ] {
        if let Some(value) = input.get(field) {
            output.insert(field.to_owned(), value.clone());
        }
    }
    if !output.contains_key("max_output_tokens") {
        if let Some(value) = input.get("max_completion_tokens") {
            output.insert("max_output_tokens".to_owned(), value.clone());
        } else if let Some(value) = input.get("max_output_tokens") {
            output.insert("max_output_tokens".to_owned(), value.clone());
        }
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

fn upstream_url(host: &str, target: TargetWire, codex: bool, native_responses: bool) -> String {
    let path = match (target, codex) {
        (TargetWire::Responses, true) => CODEX_RESPONSES_PATH,
        (TargetWire::Chat, _) => CHAT_PATH,
        (TargetWire::Responses, false) if native_responses => RESPONSES_PATH,
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
    fn openai_chat_preserves_images_hosted_tools_and_responses_fields() {
        let output = adapt_request(
            ClientWire::Chat,
            TargetWire::Responses,
            json!({
                "model": "databricks-gpt-5-6-sol",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Describe this image, then search for context"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,aW1n"}}
                    ]
                }],
                "tools": [
                    {"type": "function", "function": {
                        "name": "lookup",
                        "description": "Look up a value",
                        "parameters": {"type": "object"}
                    }},
                    {"type": "web_search", "search_context_size": "high"},
                    {"type": "image_generation", "quality": "high"},
                    {"type": "mcp", "server_label": "docs", "server_url": "https://example.com/mcp"},
                    {"type": "shell"},
                    {"type": "apply_patch"},
                    {"type": "custom", "name": "grammar", "format": {"type": "grammar"}}
                ],
                "background": true,
                "metadata": {"source": "test"},
                "prompt_cache_key": "cache-key",
                "service_tier": "default",
                "truncation": "auto",
                "max_completion_tokens": 256
            }),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();

        assert_eq!(value["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(
            value["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,aW1n"
        );
        assert_eq!(value["tools"][0]["type"], "function");
        assert_eq!(value["tools"][0]["name"], "lookup");
        assert_eq!(value["tools"][1]["type"], "web_search");
        assert_eq!(value["tools"][2]["type"], "image_generation");
        assert_eq!(value["tools"][3]["type"], "mcp");
        assert_eq!(value["tools"][4]["type"], "shell");
        assert_eq!(value["tools"][5]["type"], "apply_patch");
        assert_eq!(value["tools"][6]["type"], "custom");
        assert_eq!(value["background"], true);
        assert_eq!(value["metadata"]["source"], "test");
        assert_eq!(value["prompt_cache_key"], "cache-key");
        assert_eq!(value["service_tier"], "default");
        assert_eq!(value["truncation"], "auto");
        assert_eq!(value["max_output_tokens"], 256);
    }

    #[test]
    fn native_responses_preserve_codex_gateway_capabilities() {
        let input = json!({
            "model": "system.ai.gpt-5-6-sol",
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Use every available capability"},
                    {"type": "input_image", "image_url": "data:image/png;base64,aW1n", "detail": "high"}
                ]
            }],
            "tools": [
                {"type": "web_search"},
                {"type": "function", "name": "lookup", "parameters": {"type": "object"}},
                {"type": "custom", "name": "apply_patch"},
                {"type": "apply_patch"},
                {"type": "shell"},
                {"type": "image_generation"},
                {"type": "mcp", "server_label": "docs", "server_url": "https://example.com/mcp"}
            ],
            "include": ["web_search_call.action.sources", "reasoning.encrypted_content"],
            "stream": true
        });

        let output =
            adapt_request(ClientWire::Responses, TargetWire::Responses, input.clone()).unwrap();

        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), input);
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
    fn auto_selects_responses_from_discovered_capabilities() {
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Chat, true),
            TargetWire::Responses
        );
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Chat, false),
            TargetWire::Chat
        );
        assert_eq!(
            select_target(TargetWire::Auto, ClientWire::Responses, false),
            TargetWire::Responses
        );
        assert_eq!(
            select_request_target(
                TargetWire::Auto,
                ClientWire::Chat,
                None,
                &json!({"tools": [{"type": "web_search"}]}),
                false,
            ),
            TargetWire::Responses
        );
    }

    #[test]
    fn codex_originator_uses_codex_responses_route_without_model_filtering() {
        assert!(is_codex_originator(" Codex_CLI_RS "));
        assert_eq!(
            select_request_target(
                TargetWire::Auto,
                ClientWire::Chat,
                Some("codex_cli_rs"),
                &json!({}),
                false,
            ),
            TargetWire::Responses
        );
        assert_eq!(
            upstream_url(
                "https://workspace.example.com",
                TargetWire::Responses,
                true,
                false
            ),
            "https://workspace.example.com/ai-gateway/codex/v1/responses"
        );
        assert_eq!(
            upstream_url(
                "https://workspace.example.com",
                TargetWire::Responses,
                false,
                true,
            ),
            "https://workspace.example.com/serving-endpoints/responses"
        );
        assert_eq!(
            upstream_url(
                "https://workspace.example.com",
                TargetWire::Responses,
                false,
                false,
            ),
            "https://workspace.example.com/serving-endpoints/open-responses"
        );
    }
}
