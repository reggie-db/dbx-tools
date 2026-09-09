//! Streaming protocol translation and SSE response encoding.

use std::{
    io,
    time::{SystemTime, UNIX_EPOCH},
};

use aigw_anthropic::translate::{stream_event_to_anthropic_sse, NativeSseContext};
use aigw_core::{
    model::StreamEvent,
    translate::{ResponseTranslator, StreamParser},
};
use aigw_openai::{OpenAIResponseTranslator, ResponsesResponseTranslator};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};

use crate::{
    error::ProxyError,
    protocol::{ClientWire, TargetWire},
};

pub(crate) fn stream_response(
    client_wire: ClientWire,
    target: TargetWire,
    upstream: reqwest::Response,
    model: String,
    response_headers: HeaderMap,
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
        return Ok(sse_response(body, response_headers));
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
    Ok(sse_response(Body::from_stream(stream), response_headers))
}

fn sse_response(body: Body, mut headers: HeaderMap) -> Response {
    headers.insert(
        header::CONTENT_TYPE,
        "text/event-stream".parse().expect("valid content type"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        "no-cache".parse().expect("valid cache control"),
    );
    (StatusCode::OK, headers, body).into_response()
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

#[cfg(test)]
mod tests {
    use aigw_core::model::{FinishReason, Usage};

    use super::*;

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
}
