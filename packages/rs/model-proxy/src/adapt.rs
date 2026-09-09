//! Request and response translation between supported model protocols.

use aigw_anthropic::{
    translate::{chat_response_to_messages, messages_request_to_canonical},
    types::MessagesRequest,
};
use aigw_core::{
    model::{ChatRequest, ChatResponse},
    translate::ResponseTranslator,
};
use aigw_openai::{
    build_responses_create_request, OpenAIResponseTranslator, ResponsesRequestConfig,
    ResponsesResponseTranslator,
};
use axum::http::StatusCode;
use serde_json::{Map, Value};

use crate::{
    error::ProxyError,
    protocol::{is_codex_originator, ClientWire, TargetWire},
};

const CHAT_PATH: &str = "/serving-endpoints/chat/completions";
const CODEX_RESPONSES_PATH: &str = "/ai-gateway/codex/v1/responses";
const OPEN_RESPONSES_PATH: &str = "/serving-endpoints/open-responses";
const RESPONSES_PATH: &str = "/serving-endpoints/responses";

pub(crate) fn select_request_target(
    configured: TargetWire,
    client: ClientWire,
    originator: Option<&str>,
    input: &Value,
    native_responses: bool,
) -> TargetWire {
    let configured = if originator.is_some_and(is_codex_originator)
        || (configured == TargetWire::Auto && request_requires_responses(client, input))
    {
        TargetWire::Responses
    } else {
        configured
    };
    select_target(configured, client, native_responses)
}

pub(crate) fn adapt_request(
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

pub(crate) fn adapt_response(
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

pub(crate) fn upstream_path(
    target: TargetWire,
    codex: bool,
    native_responses: bool,
) -> &'static str {
    match (target, codex) {
        (TargetWire::Responses, true) => CODEX_RESPONSES_PATH,
        (TargetWire::Chat, _) => CHAT_PATH,
        (TargetWire::Responses, false) if native_responses => RESPONSES_PATH,
        (TargetWire::Responses, false) => OPEN_RESPONSES_PATH,
        (TargetWire::Auto, _) => unreachable!(),
    }
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,aW1n", "detail": "high"}}
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
    fn codex_uses_responses_routes() {
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
            upstream_path(TargetWire::Responses, true, false),
            "/ai-gateway/codex/v1/responses"
        );
        assert_eq!(
            upstream_path(TargetWire::Responses, false, true),
            "/serving-endpoints/responses"
        );
        assert_eq!(
            upstream_path(TargetWire::Responses, false, false),
            "/serving-endpoints/open-responses"
        );
    }
}
