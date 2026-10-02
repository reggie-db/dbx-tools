//! Typed demand-aware GraphQL event feeds for proxy observability.

use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_graphql::{Enum, Json, SimpleObject};
use axum::http::HeaderMap;
use base64::{engine::general_purpose::STANDARD, Engine};
use dbx_tools_service::{
    topic::{Topic, TopicContext, TopicEvent, TopicOptions},
    ServiceStorage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::metrics::{BucketSnapshot, RateLimitEvent};

/// Raw response bytes represented safely across GraphQL transports.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpBodyContent {
    /// Parsed JSON, text, or a data URL for binary content.
    pub(crate) content: Json<Value>,
    /// Plain base64 response bytes without a data URL prefix.
    pub(crate) content_raw: String,
    /// Number of bytes represented in this event.
    pub(crate) bytes: u64,
    /// Complete response or chunk bytes before error-mode truncation.
    pub(crate) total_bytes: u64,
    /// Whether error-mode capture omitted bytes beyond 16 KiB.
    pub(crate) truncated: bool,
    /// Response content type when supplied.
    pub(crate) content_type: Option<String>,
    /// Zero-based chunk index for a streaming response.
    pub(crate) chunk_index: Option<u64>,
}

/// One HTTP header preserving textual or binary value bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpHeader {
    /// Lowercase HTTP header name.
    pub(crate) name: String,
    /// All values observed for this header name.
    pub(crate) values: Vec<HttpHeaderValue>,
}

/// One textual and raw HTTP header value.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpHeaderValue {
    /// Lossy UTF-8 header value.
    pub(crate) value: String,
    /// Plain base64 header bytes.
    pub(crate) value_raw: String,
}

/// Request hop represented by one uniform HTTP request event.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Enum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestHop {
    ClientToProxy,
    ProxyToUpstream,
}

/// Response hop represented by one uniform HTTP response event.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Enum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ResponseHop {
    UpstreamToProxy,
    ProxyToClient,
}

/// One parsed server-sent event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SseEvent {
    /// SSE event name.
    pub(crate) event: String,
    /// Parsed JSON or text SSE data.
    pub(crate) data: Json<Value>,
    /// Plain base64 SSE data bytes.
    pub(crate) data_raw: String,
    /// SSE event identifier when supplied.
    pub(crate) id: Option<String>,
}

impl SseEvent {
    pub(crate) fn new(event: String, data: String, id: Option<String>) -> Self {
        let (data, data_raw) = graphql_content(data.as_bytes(), None);
        Self {
            event,
            data,
            data_raw,
            id,
        }
    }
}

/// Uniform HTTP request metadata for both proxy hops.
#[derive(Clone, Debug, Deserialize, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpRequestEvent {
    pub(crate) request_id: u64,
    pub(crate) hop: RequestHop,
    pub(crate) elapsed_ms: u64,
    pub(crate) attempt: Option<u32>,
    pub(crate) method: String,
    pub(crate) host: Option<String>,
    pub(crate) path: String,
    pub(crate) headers: Option<Vec<HttpHeader>>,
    pub(crate) body_bytes: Option<u64>,
    pub(crate) client_protocol: Option<String>,
    pub(crate) target_protocol: Option<String>,
    pub(crate) preferred_model: Option<String>,
    pub(crate) actual_model: Option<String>,
    pub(crate) streaming: Option<bool>,
    pub(crate) fallback_step: Option<u32>,
    pub(crate) body: Option<HttpBodyContent>,
}

/// Uniform HTTP response metadata, body chunks, and SSE events for both hops.
#[derive(Clone, Debug, Deserialize, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpResponseEvent {
    pub(crate) request_id: u64,
    pub(crate) hop: ResponseHop,
    pub(crate) elapsed_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) attempt: Option<u32>,
    pub(crate) method: String,
    pub(crate) host: Option<String>,
    pub(crate) path: String,
    pub(crate) status: Option<u16>,
    pub(crate) headers: Option<Vec<HttpHeader>>,
    pub(crate) response_bytes: Option<u64>,
    pub(crate) client_protocol: Option<String>,
    pub(crate) target_protocol: Option<String>,
    pub(crate) preferred_model: Option<String>,
    pub(crate) actual_model: Option<String>,
    pub(crate) streaming: Option<bool>,
    pub(crate) fallback_step: Option<u32>,
    pub(crate) transport_error: Option<String>,
    pub(crate) body: Option<HttpBodyContent>,
    pub(crate) sse: Option<SseEvent>,
}

/// Event kind used to include or omit proxy hops in one subscription.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Enum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HttpEventKind {
    ClientRequest,
    UpstreamRequest,
    UpstreamResponse,
    ClientResponse,
    UpstreamResponseSse,
    ClientResponseSse,
}

/// Uniform event envelope for every request and response hop.
#[derive(Clone, Debug, Deserialize, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpExchangeEvent {
    pub(crate) kind: HttpEventKind,
    pub(crate) request: Option<HttpRequestEvent>,
    pub(crate) response: Option<HttpResponseEvent>,
}

impl HttpExchangeEvent {
    pub(crate) fn from_request(request: HttpRequestEvent) -> Self {
        let kind = match request.hop {
            RequestHop::ClientToProxy => HttpEventKind::ClientRequest,
            RequestHop::ProxyToUpstream => HttpEventKind::UpstreamRequest,
        };
        Self {
            kind,
            request: Some(request),
            response: None,
        }
    }

    pub(crate) fn from_response(response: HttpResponseEvent) -> Self {
        let kind = match (response.hop, response.sse.is_some()) {
            (ResponseHop::UpstreamToProxy, false) => HttpEventKind::UpstreamResponse,
            (ResponseHop::ProxyToClient, false) => HttpEventKind::ClientResponse,
            (ResponseHop::UpstreamToProxy, true) => HttpEventKind::UpstreamResponseSse,
            (ResponseHop::ProxyToClient, true) => HttpEventKind::ClientResponseSse,
        };
        Self {
            kind,
            request: None,
            response: Some(response),
        }
    }

    pub(crate) fn model_matches(&self, models: &[String]) -> bool {
        if models.is_empty() {
            return true;
        }
        let candidates = self
            .request
            .as_ref()
            .into_iter()
            .flat_map(|request| {
                [
                    request.preferred_model.as_deref(),
                    request.actual_model.as_deref(),
                ]
            })
            .chain(self.response.as_ref().into_iter().flat_map(|response| {
                [
                    response.preferred_model.as_deref(),
                    response.actual_model.as_deref(),
                ]
            }))
            .flatten();
        candidates.into_iter().any(|candidate| {
            models
                .iter()
                .any(|model| candidate.eq_ignore_ascii_case(model))
        })
    }
}

/// Closed aggregate-window resolution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Enum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MetricWindowResolution {
    FiveSeconds,
    OneMinute,
}

/// One closed metrics window emitted exactly once.
#[derive(Clone, Debug, Deserialize, Serialize, SimpleObject)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricWindowEvent {
    /// Window resolution.
    pub(crate) resolution: MetricWindowResolution,
    /// Closed aggregate bucket.
    pub(crate) bucket: BucketSnapshot,
}

/// Shared event topics for one model-proxy process.
#[derive(Clone)]
pub(crate) struct ProxyFeeds {
    show_sensitive: bool,
    next_request_id: Arc<AtomicU64>,
    pub(crate) http: Topic<HttpExchangeEvent>,
    pub(crate) five_second_windows: Topic<MetricWindowEvent>,
    pub(crate) minute_windows: Topic<MetricWindowEvent>,
    pub(crate) rate_limits: Topic<RateLimitEvent>,
}

impl ProxyFeeds {
    pub(crate) fn new(
        storage: Option<ServiceStorage>,
        show_sensitive: bool,
    ) -> dbx_tools_service::Result<Self> {
        let context = TopicContext::new(storage, "model-proxy.events")?;
        Ok(Self {
            show_sensitive,
            next_request_id: Arc::new(AtomicU64::new(1)),
            http: context.topic("http", TopicOptions::live())?,
            five_second_windows: context.topic(
                "windows-five-seconds",
                TopicOptions::replay(
                    NonZeroUsize::new(720).expect("window retention is non-zero"),
                    true,
                ),
            )?,
            minute_windows: context.topic(
                "windows-one-minute",
                TopicOptions::replay(
                    NonZeroUsize::new(1_440).expect("window retention is non-zero"),
                    true,
                ),
            )?,
            rate_limits: context.topic(
                "rate-limits",
                TopicOptions::replay(
                    NonZeroUsize::new(128).expect("rate-limit retention is non-zero"),
                    true,
                ),
            )?,
        })
    }

    pub(crate) fn next_request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn headers(&self, headers: &HeaderMap) -> Vec<HttpHeader> {
        let mut grouped = BTreeMap::<String, Vec<HttpHeaderValue>>::new();
        for (name, value) in headers {
            let values = grouped.entry(name.as_str().to_owned()).or_default();
            if is_sensitive_header(name.as_str()) && !self.show_sensitive {
                if values.is_empty() {
                    values.push(HttpHeaderValue {
                        value: "[REDACTED]".to_owned(),
                        value_raw: STANDARD.encode("[REDACTED]"),
                    });
                }
            } else {
                values.push(HttpHeaderValue {
                    value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
                    value_raw: STANDARD.encode(value.as_bytes()),
                });
            }
        }
        grouped
            .into_iter()
            .map(|(name, values)| HttpHeader { name, values })
            .collect()
    }

    pub(crate) fn request_body(
        &self,
        bytes: &[u8],
        content_type: Option<&str>,
        chunk_index: u64,
    ) -> Option<HttpBodyContent> {
        capture_body(
            self.http.subscriber_count() > 0,
            bytes,
            bytes.len(),
            content_type,
            Some(chunk_index),
        )
    }

    pub(crate) fn response_body(
        &self,
        bytes: &[u8],
        total_bytes: usize,
        content_type: Option<&str>,
        chunk_index: Option<u64>,
    ) -> Option<HttpBodyContent> {
        capture_body(
            self.http.subscriber_count() > 0,
            bytes,
            total_bytes,
            content_type,
            chunk_index,
        )
    }
}

fn capture_body(
    demanded: bool,
    bytes: &[u8],
    total_bytes: usize,
    content_type: Option<&str>,
    chunk_index: Option<u64>,
) -> Option<HttpBodyContent> {
    if !demanded {
        return None;
    }
    let retained = bytes;
    let (content, content_raw) = graphql_content(retained, content_type);
    Some(HttpBodyContent {
        content,
        content_raw,
        bytes: retained.len() as u64,
        total_bytes: total_bytes as u64,
        truncated: retained.len() < total_bytes,
        content_type: content_type.map(str::to_owned),
        chunk_index,
    })
}

fn graphql_content(bytes: &[u8], content_type: Option<&str>) -> (Json<Value>, String) {
    let content_raw = STANDARD.encode(bytes);
    let content = if content_type.is_none_or(is_textual_content_type) {
        std::str::from_utf8(bytes)
            .ok()
            .map(|text| {
                serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
            })
            .unwrap_or_else(|| {
                Value::String(format!(
                    "data:{};base64,{content_raw}",
                    content_type.unwrap_or("application/octet-stream")
                ))
            })
    } else {
        Value::String(format!(
            "data:{};base64,{content_raw}",
            content_type.unwrap_or("application/octet-stream")
        ))
    };
    (Json(content), content_raw)
}

fn is_textual_content_type(content_type: &str) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    media_type.starts_with("text/")
        || media_type.contains("json")
        || media_type.contains("xml")
        || media_type.contains("graphql")
        || media_type.contains("javascript")
        || media_type == "application/x-www-form-urlencoded"
}

fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "x-databricks-token"
    )
}

macro_rules! stream_event {
    ($name:ident, $payload:ty) => {
        #[derive(Clone, Debug, SimpleObject)]
        pub(crate) struct $name {
            /// Monotonic topic sequence.
            pub(crate) sequence: u64,
            /// Publication time in Unix milliseconds.
            pub(crate) published_at_ms: u64,
            /// Typed event payload.
            pub(crate) event: $payload,
        }

        impl From<TopicEvent<$payload>> for $name {
            fn from(value: TopicEvent<$payload>) -> Self {
                Self {
                    sequence: value.sequence,
                    published_at_ms: value.published_at_ms,
                    event: value.payload,
                }
            }
        }
    };
}

stream_event!(HttpStreamEvent, HttpExchangeEvent);
stream_event!(MetricWindowStreamEvent, MetricWindowEvent);
stream_event!(RateLimitStreamEvent, RateLimitEvent);

#[cfg(test)]
mod tests {
    use super::*;

    fn feeds() -> ProxyFeeds {
        ProxyFeeds::new(None, false).unwrap()
    }

    #[test]
    fn body_capture_does_no_work_without_subscribers() {
        let feeds = feeds();
        assert!(feeds.response_body(b"body", 4, None, None).is_none());
        assert!(feeds.request_body(b"body", None, 0).is_none());
    }

    #[test]
    fn response_bodies_are_uncapped_when_subscribed() {
        let feeds = feeds();
        let _responses = feeds.http.subscribe(None);
        let bytes = vec![9; 32 * 1024];
        let body = feeds
            .response_body(&bytes, bytes.len(), None, Some(3))
            .unwrap();

        assert_eq!(body.bytes, bytes.len() as u64);
        assert!(!body.truncated);
        assert_eq!(body.chunk_index, Some(3));
    }

    #[test]
    fn body_content_uses_json_text_or_data_urls() {
        let feeds = feeds();
        let _responses = feeds.http.subscribe(None);
        let text = feeds
            .response_body(
                br#"{"ok":true}"#,
                11,
                Some("application/json; charset=utf-8"),
                None,
            )
            .unwrap();
        assert_eq!(text.content.0, serde_json::json!({"ok": true}));
        assert_eq!(text.content_raw, "eyJvayI6dHJ1ZX0=");

        let binary = feeds
            .response_body(
                &[0, 159, 146, 150],
                4,
                Some("application/octet-stream"),
                None,
            )
            .unwrap();
        assert_eq!(
            binary.content.0.as_str(),
            Some("data:application/octet-stream;base64,AJ+Slg==")
        );
        assert_eq!(binary.content_raw, "AJ+Slg==");
    }

    #[test]
    fn sensitive_headers_are_redacted_unless_enabled_at_startup() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "proxy.example".parse().unwrap());
        headers.insert("authorization", "Bearer secret".parse().unwrap());
        headers.append("x-test", "one".parse().unwrap());
        headers.append("x-test", "two".parse().unwrap());
        let captured = feeds().headers(&headers);
        assert!(captured.iter().any(|header| {
            header.name == "host"
                && header.values[0].value == "proxy.example"
                && header.values[0].value_raw == "cHJveHkuZXhhbXBsZQ=="
        }));
        assert!(captured.iter().any(|header| {
            header.name == "authorization" && header.values[0].value == "[REDACTED]"
        }));
        assert!(captured.iter().any(|header| {
            header.name == "x-test"
                && header
                    .values
                    .iter()
                    .map(|value| value.value.as_str())
                    .eq(["one", "two"])
        }));
        let shown = ProxyFeeds::new(None, true).unwrap().headers(&headers);
        assert!(shown.iter().any(|header| {
            header.name == "authorization" && header.values[0].value == "Bearer secret"
        }));
    }

    #[test]
    fn request_bodies_are_uncapped_and_demand_gated() {
        let feeds = feeds();
        let bytes = vec![b'a'; 32 * 1024];
        assert!(feeds.request_body(&bytes, Some("text/plain"), 0).is_none());

        let _requests = feeds.http.subscribe(None);
        let body = feeds.request_body(&bytes, Some("text/plain"), 0).unwrap();
        assert_eq!(body.bytes, bytes.len() as u64);
        assert_eq!(body.total_bytes, bytes.len() as u64);
        assert!(!body.truncated);
        assert_eq!(body.content.0.as_str().unwrap().len(), bytes.len());
    }

    #[test]
    fn graphql_event_filters_models_and_kinds() {
        let exchange = HttpExchangeEvent::from_request(HttpRequestEvent {
            request_id: 1,
            hop: RequestHop::ProxyToUpstream,
            elapsed_ms: 5,
            attempt: Some(1),
            method: "POST".into(),
            host: Some("workspace.example".into()),
            path: "/serving-endpoints/model/invocations".into(),
            headers: Some(vec![
                HttpHeader {
                    name: "content-type".into(),
                    values: vec![HttpHeaderValue {
                        value: "application/json".into(),
                        value_raw: "YXBwbGljYXRpb24vanNvbg==".into(),
                    }],
                },
                HttpHeader {
                    name: "authorization".into(),
                    values: vec![HttpHeaderValue {
                        value: "Bearer secret".into(),
                        value_raw: "QmVhcmVyIHNlY3JldA==".into(),
                    }],
                },
            ]),
            body_bytes: Some(2),
            client_protocol: None,
            target_protocol: Some("responses".into()),
            preferred_model: Some("preferred".into()),
            actual_model: Some("actual".into()),
            streaming: Some(false),
            fallback_step: Some(1),
            body: None,
        });
        assert!(exchange.model_matches(&["ACTUAL".into()]));
        assert!(!exchange.model_matches(&["other".into()]));

        assert_eq!(exchange.kind, HttpEventKind::UpstreamRequest);
    }
}
