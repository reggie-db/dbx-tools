//! Streaming protocol translation and SSE response encoding.

use std::{
    io,
    net::SocketAddr,
    time::{Instant, SystemTime, UNIX_EPOCH},
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
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::{
    error::ProxyError,
    protocol::{ClientWire, TargetWire},
    throttle::{token_usage_value, ResponseTokenUsage, ThrottleAcquisition},
};

const USAGE_TAIL_BYTES: usize = 128 * 1024;

/// Request metadata emitted when an SSE body completes or is dropped.
#[derive(Debug)]
pub(crate) struct StreamLogContext {
    /// Protocol presented by the caller.
    pub(crate) client_wire: ClientWire,
    /// Protocol selected for the upstream request.
    pub(crate) target: TargetWire,
    /// Model requested by the caller.
    pub(crate) requested_model: String,
    /// Databricks endpoint selected by the proxy.
    pub(crate) resolved_model: String,
    /// Immediate TCP peer.
    pub(crate) peer: SocketAddr,
    /// Raw inbound request size.
    pub(crate) request_bytes: usize,
    /// Start of the complete proxy request.
    pub(crate) started: Instant,
    /// Local token reservation reconciled when usage is reported.
    pub(crate) throttle: ThrottleAcquisition,
    /// Number of upstream attempts before the stream connected.
    pub(crate) upstream_attempt: u32,
}

#[derive(Debug, Default)]
struct NativeUsageObserver {
    tail: Vec<u8>,
}

impl NativeUsageObserver {
    fn push(&mut self, chunk: &[u8]) {
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > USAGE_TAIL_BYTES {
            self.tail.drain(..self.tail.len() - USAGE_TAIL_BYTES);
        }
    }

    fn usage(&self) -> ResponseTokenUsage {
        let marker = br#""usage":"#;
        let Some(index) = self
            .tail
            .windows(marker.len())
            .rposition(|window| window == marker)
        else {
            return ResponseTokenUsage::default();
        };
        let source = &self.tail[index + marker.len()..];
        let Some(Ok(usage)) = serde_json::Deserializer::from_slice(source)
            .into_iter::<Value>()
            .next()
        else {
            return ResponseTokenUsage::default();
        };
        token_usage_value(&usage)
    }
}

struct StreamCompletion {
    context: StreamLogContext,
    response_bytes: u64,
    usage: ResponseTokenUsage,
    finished: bool,
    failed: bool,
}

impl StreamCompletion {
    fn new(context: StreamLogContext) -> Self {
        Self {
            context,
            response_bytes: 0,
            usage: ResponseTokenUsage::default(),
            finished: false,
            failed: false,
        }
    }

    fn record_bytes(&mut self, bytes: usize) {
        self.response_bytes = self.response_bytes.saturating_add(bytes as u64);
    }

    fn observe(&mut self, event: &StreamEvent) {
        if let StreamEvent::Usage(usage) = event {
            let input = usage.prompt_tokens.unwrap_or_default();
            let output = usage.completion_tokens.unwrap_or_default();
            self.usage = ResponseTokenUsage {
                reported: true,
                input,
                output,
                total: usage
                    .total_tokens
                    .unwrap_or_else(|| input.saturating_add(output)),
            };
        }
    }

    fn finish(&mut self, failed: bool) {
        self.finished = true;
        self.failed = failed;
    }

    async fn reconcile(&self) {
        self.context.throttle.reconcile(self.usage).await;
    }
}

impl Drop for StreamCompletion {
    fn drop(&mut self) {
        tracing::info!(
            client_wire = ?self.context.client_wire,
            target = ?self.context.target,
            requested_model = self.context.requested_model,
            resolved_model = self.context.resolved_model,
            streaming = true,
            client_ip = %self.context.peer.ip(),
            client_port = self.context.peer.port(),
            request_bytes = self.context.request_bytes,
            response_bytes = self.response_bytes,
            raw_estimated_input_tokens = self.context.throttle.raw_estimated_input_tokens,
            estimate_factor = self.context.throttle.estimate_factor,
            estimated_input_tokens = self.context.throttle.estimated_input_tokens,
            reserved_output_tokens = self.context.throttle.reserved_output_tokens,
            estimated_tokens = self.context.throttle.estimated_tokens,
            input_tokens = self.usage.input,
            output_tokens = self.usage.output,
            total_tokens = self.usage.total,
            upstream_attempt = self.context.upstream_attempt,
            token_throttle_mode = ?self.context.throttle.mode,
            token_throttle_active = self.context.throttle.active,
            token_limit_input = self.context.throttle.input_limit,
            token_reservation_input = self.context.throttle.reserved_input_tokens,
            token_window_used_before = self.context.throttle.input_window_used_before,
            token_window_wait_ms = self.context.throttle.wait.as_millis(),
            oversized_request = false,
            duration_ms = self.context.started.elapsed().as_millis(),
            finished = self.finished,
            failed = self.failed,
            "model stream completed"
        );
    }
}

pub(crate) fn stream_response(
    client_wire: ClientWire,
    target: TargetWire,
    upstream: reqwest::Response,
    model: String,
    response_headers: HeaderMap,
    log_context: StreamLogContext,
) -> Result<Response, ProxyError> {
    // Preserve native SSE framing when no protocol translation is required.
    if matches!(
        (client_wire, target),
        (ClientWire::Chat, TargetWire::Chat) | (ClientWire::Responses, TargetWire::Responses)
    ) {
        let mut upstream = upstream.bytes_stream();
        let stream = async_stream::stream! {
            let mut completion = StreamCompletion::new(log_context);
            let mut usage = NativeUsageObserver::default();
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(chunk) => {
                        usage.push(&chunk);
                        completion.record_bytes(chunk.len());
                        yield Ok::<Bytes, io::Error>(chunk);
                    }
                    Err(error) => {
                        completion.finish(true);
                        yield Err(io::Error::other(error.to_string()));
                        return;
                    }
                }
            }
            completion.usage = usage.usage();
            completion.reconcile().await;
            completion.finish(false);
        };
        return Ok(sse_response(Body::from_stream(stream), response_headers));
    }

    let mut parser: Box<dyn StreamParser> = match target {
        TargetWire::Chat => OpenAIResponseTranslator.stream_parser(),
        TargetWire::Responses => ResponsesResponseTranslator.stream_parser(),
        TargetWire::Auto => unreachable!("auto target is resolved before streaming"),
    };
    let mut events = upstream.bytes_stream().eventsource();
    let stream = async_stream::stream! {
        let mut completion = StreamCompletion::new(log_context);
        let mut anthropic = NativeSseContext::with_pinned_model(model.clone());
        let mut chat = ChatSseContext::new(model);
        let mut failed = false;

        while let Some(event) = events.next().await {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    let frame = stream_error(client_wire, &error.to_string());
                    completion.record_bytes(frame.len());
                    yield Ok::<Bytes, io::Error>(frame);
                    failed = true;
                    break;
                }
            };
            let parsed = match parser.parse_event(&event.event, &event.data) {
                Ok(parsed) => parsed,
                Err(error) => {
                    let frame = stream_error(client_wire, &error.to_string());
                    completion.record_bytes(frame.len());
                    yield Ok(frame);
                    failed = true;
                    break;
                }
            };
            for canonical in parsed {
                completion.observe(&canonical);
                for frame in encode_stream_event(
                    client_wire,
                    &mut anthropic,
                    &mut chat,
                    canonical,
                ) {
                    completion.record_bytes(frame.len());
                    yield Ok(frame);
                }
            }
        }
        if !failed {
            // Parsers can buffer terminal usage or completion events until EOF.
            match parser.finish() {
                Ok(parsed) => {
                    for canonical in parsed {
                        completion.observe(&canonical);
                        for frame in encode_stream_event(
                            client_wire,
                            &mut anthropic,
                            &mut chat,
                            canonical,
                        ) {
                            completion.record_bytes(frame.len());
                            yield Ok(frame);
                        }
                    }
                }
                Err(error) => {
                    failed = true;
                    let frame = stream_error(client_wire, &error.to_string());
                    completion.record_bytes(frame.len());
                    yield Ok(frame);
                }
            }
        }
        completion.reconcile().await;
        completion.finish(failed);
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
    fn native_usage_observer_reads_split_responses_and_chat_events() {
        let mut responses = NativeUsageObserver::default();
        responses.push(br#"data: {"type":"response.completed","response":{"usage":{"input_"#);
        responses.push(br#"tokens":12,"output_tokens":3,"total_tokens":15}}}"#);
        assert_eq!(
            responses.usage(),
            ResponseTokenUsage {
                reported: true,
                input: 12,
                output: 3,
                total: 15,
            }
        );

        let mut chat = NativeUsageObserver::default();
        chat.push(
            br#"data: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}"#,
        );
        assert_eq!(
            chat.usage(),
            ResponseTokenUsage {
                reported: true,
                input: 8,
                output: 2,
                total: 10,
            }
        );
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
}
