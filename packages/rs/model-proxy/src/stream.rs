//! Streaming protocol translation and SSE response encoding.

use std::{
    convert::Infallible,
    io,
    pin::Pin,
    task::{Context, Poll},
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
use eventsource_stream::{EventStream, Eventsource};
use futures_util::{FutureExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{
    error::ProxyError,
    protocol::{ClientWire, TargetWire},
    request_log::RequestLogContext,
    throttle::{response_token_usage, ResponseTokenUsage},
};

const MAX_OBSERVED_SSE_EVENT_BYTES: usize = 1024 * 1024;

/// Request metadata emitted when an SSE body completes or is dropped.
#[derive(Debug)]
pub(crate) struct StreamLogContext {
    /// Protocol presented by the caller.
    pub(crate) client_wire: ClientWire,
    /// Protocol selected for the upstream request.
    pub(crate) target: TargetWire,
    /// Shared request metadata and local token reservation.
    pub(crate) request: RequestLogContext,
}

/// Bounded input for observing native SSE frames without changing their wire bytes.
struct NativeUsageInput {
    receiver: mpsc::Receiver<Bytes>,
}

impl Stream for NativeUsageInput {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.receiver.poll_recv(context) {
            Poll::Ready(Some(chunk)) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Observes usage from complete native SSE events while retaining only parser state.
struct NativeUsageObserver {
    sender: Option<mpsc::Sender<Bytes>>,
    events: EventStream<NativeUsageInput>,
    event_size: SseEventSize,
    usage: ResponseTokenUsage,
    observing: bool,
}

#[derive(Default)]
struct SseEventSize {
    bytes: usize,
    line_has_data: bool,
    previous_was_cr: bool,
}

impl SseEventSize {
    fn accepts(&mut self, chunk: &[u8]) -> bool {
        for &byte in chunk {
            self.bytes = self.bytes.saturating_add(1);
            if self.bytes > MAX_OBSERVED_SSE_EVENT_BYTES {
                return false;
            }
            match byte {
                b'\r' => {
                    if !self.line_has_data {
                        self.bytes = 0;
                    }
                    self.line_has_data = false;
                    self.previous_was_cr = true;
                }
                b'\n' if self.previous_was_cr => {
                    self.previous_was_cr = false;
                }
                b'\n' => {
                    if !self.line_has_data {
                        self.bytes = 0;
                    }
                    self.line_has_data = false;
                }
                _ => {
                    self.line_has_data = true;
                    self.previous_was_cr = false;
                }
            }
        }
        true
    }
}

impl Default for NativeUsageObserver {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel(1);
        Self {
            sender: Some(sender),
            events: EventStream::new(NativeUsageInput { receiver }),
            event_size: SseEventSize::default(),
            usage: ResponseTokenUsage::default(),
            observing: true,
        }
    }
}

impl NativeUsageObserver {
    /// Observe one upstream chunk and return the exact bytes supplied by the caller.
    async fn observe_chunk(&mut self, chunk: Bytes) -> Bytes {
        if !self.observing {
            return chunk;
        }
        if !self.event_size.accepts(&chunk) {
            self.stop();
            return chunk;
        }
        let Some(sender) = self.sender.as_ref() else {
            return chunk;
        };
        if sender.send(chunk.clone()).await.is_err() {
            self.stop();
            return chunk;
        }
        self.drain_ready();
        chunk
    }

    /// Close the framed input and consume every complete event still buffered by the parser.
    async fn finish(mut self) -> ResponseTokenUsage {
        self.sender.take();
        if self.observing {
            while let Some(event) = self.events.next().await {
                match event {
                    Ok(event) => self.observe(&event.data),
                    Err(_) => break,
                }
            }
        }
        self.usage
    }

    fn drain_ready(&mut self) {
        loop {
            match self.events.next().now_or_never() {
                Some(Some(Ok(event))) => self.observe(&event.data),
                Some(Some(Err(_))) | Some(None) => {
                    self.stop();
                    break;
                }
                None => break,
            }
        }
    }

    fn observe(&mut self, data: &str) {
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return;
        };
        let usage = response_token_usage(&payload);
        if usage.reported {
            self.usage = usage;
        }
    }

    fn stop(&mut self) {
        self.observing = false;
        self.sender.take();
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
        self.context.request.reconcile(self.usage).await;
    }
}

impl Drop for StreamCompletion {
    fn drop(&mut self) {
        self.context.request.stream_completed(
            self.context.client_wire,
            self.context.target,
            self.response_bytes,
            self.usage,
            self.finished,
            self.failed,
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
                        let chunk = usage.observe_chunk(chunk).await;
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
            completion.usage = usage.finish().await;
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

    async fn observed_usage(chunks: impl IntoIterator<Item = Bytes>) -> ResponseTokenUsage {
        let mut observer = NativeUsageObserver::default();
        for chunk in chunks {
            observer.observe_chunk(chunk).await;
        }
        observer.finish().await
    }

    #[tokio::test]
    async fn native_usage_observer_returns_upstream_chunks_unchanged() {
        let chunks = vec![
            Bytes::from_static(b"event: completion\r\n"),
            Bytes::from_static(b"data: {\"usage\": null}\r\n\r\n"),
        ];
        let mut observer = NativeUsageObserver::default();
        let mut forwarded = Vec::new();
        for chunk in chunks.iter().cloned() {
            forwarded.push(observer.observe_chunk(chunk).await);
        }
        assert_eq!(forwarded, chunks);
    }

    #[tokio::test]
    async fn native_usage_observer_handles_arbitrary_boundaries_crlf_and_json_whitespace() {
        let event = concat!(
            "event: completion\r\n",
            "data: { \"usage\" : { \"prompt_tokens\" : 8, \"completion_tokens\" : 2, ",
            "\"total_tokens\" : 10 } }\r\n",
            "\r\n"
        );
        let usage = observed_usage(
            event
                .as_bytes()
                .chunks(1)
                .map(Bytes::copy_from_slice)
                .collect::<Vec<_>>(),
        )
        .await;
        assert_eq!(
            usage,
            ResponseTokenUsage {
                reported: true,
                input: 8,
                output: 2,
                total: 10,
            }
        );
    }

    #[tokio::test]
    async fn native_usage_observer_reads_multiline_responses_event() {
        let event = concat!(
            "event: response.completed\r\n",
            "data: {\"type\":\"response.completed\",\"response\":\r\n",
            "data: {\"usage\" : {\"input_tokens\":12,\"output_tokens\":3,\"total_tokens\":15}}}\r\n",
            "\r\n"
        );
        let responses = observed_usage(
            event
                .as_bytes()
                .chunks(7)
                .map(Bytes::copy_from_slice)
                .collect::<Vec<_>>(),
        )
        .await;
        assert_eq!(
            responses,
            ResponseTokenUsage {
                reported: true,
                input: 12,
                output: 3,
                total: 15,
            }
        );
    }

    #[tokio::test]
    async fn native_usage_observer_ignores_null_and_nested_unrelated_usage() {
        let ignored = observed_usage([Bytes::from_static(
            br#"data: {"usage":null,"metadata":{"usage":{"prompt_tokens":90,"completion_tokens":9}}}

"#,
        )])
        .await;
        assert_eq!(ignored, ResponseTokenUsage::default());

        let retained = observed_usage([Bytes::from_static(
            br#"data: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}

data: {"usage":null,"metadata":{"usage":{"prompt_tokens":90,"completion_tokens":9}}}

"#,
        )])
        .await;
        assert_eq!(
            retained,
            ResponseTokenUsage {
                reported: true,
                input: 8,
                output: 2,
                total: 10,
            }
        );
    }

    #[tokio::test]
    async fn native_usage_observer_reads_usage_from_event_larger_than_old_tail() {
        let event = format!(
            "data: {{\"usage\":{{\"prompt_tokens\":21,\"completion_tokens\":5}},\"padding\":\"{}\"}}\n\n",
            "x".repeat(256 * 1024)
        );
        let usage = observed_usage(
            event
                .as_bytes()
                .chunks(4093)
                .map(Bytes::copy_from_slice)
                .collect::<Vec<_>>(),
        )
        .await;
        assert_eq!(
            usage,
            ResponseTokenUsage {
                reported: true,
                input: 21,
                output: 5,
                total: 26,
            }
        );
    }

    #[tokio::test]
    async fn native_usage_observer_bounds_oversized_event_state() {
        let event = format!(
            "data: {{\"usage\":{{\"prompt_tokens\":21,\"completion_tokens\":5}},\"padding\":\"{}\"}}\n\n",
            "x".repeat(MAX_OBSERVED_SSE_EVENT_BYTES)
        );
        let usage = observed_usage(
            event
                .as_bytes()
                .chunks(4093)
                .map(Bytes::copy_from_slice)
                .collect::<Vec<_>>(),
        )
        .await;
        assert_eq!(usage, ResponseTokenUsage::default());
    }

    #[tokio::test]
    async fn native_usage_observer_ignores_truncated_and_malformed_streams() {
        let truncated = observed_usage([Bytes::from_static(
            br#"data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}"#,
        )])
        .await;
        assert_eq!(truncated, ResponseTokenUsage::default());

        let malformed = observed_usage([
            Bytes::from_static(b"data: \xff\n\n"),
            Bytes::from_static(
                br#"data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}

"#,
            ),
        ])
        .await;
        assert_eq!(malformed, ResponseTokenUsage::default());
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
