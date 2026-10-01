//! Bounded process-local metrics, machine endpoints, and embedded dashboard assets.

use std::{
    fmt,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    str::FromStr,
    task::{Context, Poll},
};

#[cfg(feature = "metrics")]
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

#[cfg(feature = "metrics")]
use hdrhistogram::Histogram;
#[cfg(feature = "metrics")]
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
#[cfg(feature = "metrics-ui")]
use rust_embed::RustEmbed;
use serde::Serialize;
#[cfg(feature = "metrics")]
use tokio::sync::broadcast;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
};

use crate::{
    adaptive::AutoTransition, request_log::RequestOutcome, throttle::ThrottleModelSnapshot,
};
#[cfg(feature = "metrics")]
use crate::{adaptive::AutoTransitionKind, request_log::ReasoningSetting};

const MODEL_SERIES_LIMIT: usize = 32;
#[cfg(feature = "metrics")]
const DETAILED_BUCKET_LIMIT: usize = 720;
#[cfg(feature = "metrics")]
const ROLLUP_BUCKET_LIMIT: usize = 1_440;
#[cfg(feature = "metrics")]
const RATE_LIMIT_EVENT_LIMIT: usize = 128;
const RETENTION_TARGET_BYTES: u64 = 16 * 1024 * 1024;

/// Requested metrics behavior before build capabilities are resolved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MetricsOption {
    Ui,
    Collect,
    Off,
    Fullest,
}

impl fmt::Display for MetricsOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ui => "ui",
            Self::Collect => "collect",
            Self::Off => "off",
            Self::Fullest => "true",
        })
    }
}

impl FromStr for MetricsOption {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ui" => Ok(Self::Ui),
            "collect" => Ok(Self::Collect),
            "off" | "false" => Ok(Self::Off),
            "true" => Ok(Self::Fullest),
            _ => Err("expected ui, collect, off, true, or false".to_owned()),
        }
    }
}

/// Resolved metrics behavior supported by the current binary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MetricsMode {
    Ui,
    Collect,
    Off,
}

impl fmt::Display for MetricsMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ui => "ui",
            Self::Collect => "collect",
            Self::Off => "off",
        })
    }
}

pub(crate) const fn default_metrics_option() -> MetricsOption {
    if cfg!(feature = "metrics-ui") {
        MetricsOption::Ui
    } else if cfg!(feature = "metrics") {
        MetricsOption::Collect
    } else {
        MetricsOption::Off
    }
}

/// Validated metrics configuration for the running listener.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct MetricsConfig {
    pub(crate) mode: MetricsMode,
    pub(crate) routes_visible: bool,
}

impl MetricsConfig {
    pub(crate) fn resolve(
        requested: MetricsOption,
        host: IpAddr,
        metrics_public: bool,
    ) -> Result<Self, MetricsError> {
        let mode = match requested {
            MetricsOption::Off => MetricsMode::Off,
            MetricsOption::Fullest if cfg!(feature = "metrics-ui") => MetricsMode::Ui,
            MetricsOption::Fullest if cfg!(feature = "metrics") => MetricsMode::Collect,
            MetricsOption::Ui if cfg!(feature = "metrics-ui") => MetricsMode::Ui,
            MetricsOption::Collect if cfg!(feature = "metrics") => MetricsMode::Collect,
            MetricsOption::Ui => return Err(MetricsError::UiUnavailable),
            MetricsOption::Collect | MetricsOption::Fullest => {
                return Err(MetricsError::CollectionUnavailable)
            }
        };
        Ok(Self {
            mode,
            routes_visible: mode != MetricsMode::Off && (host.is_loopback() || metrics_public),
        })
    }
}

#[derive(thiserror::Error)]
pub(crate) enum MetricsError {
    #[error("metrics collection is not compiled into this binary; use --metrics=false")]
    CollectionUnavailable,
    #[error("the metrics dashboard is not compiled into this binary; use --metrics=collect")]
    UiUnavailable,
    #[cfg(feature = "metrics")]
    #[error("could not install the metrics recorder: {0}")]
    Recorder(String),
}

impl fmt::Debug for MetricsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

/// Cloneable metrics runtime. A metrics-free build retains only the selected mode.
#[derive(Clone)]
pub(crate) struct MetricsRuntime {
    config: MetricsConfig,
    #[cfg(feature = "metrics")]
    inner: Option<Arc<MetricsInner>>,
}

impl fmt::Debug for MetricsRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MetricsRuntime")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl MetricsRuntime {
    pub(crate) fn new(config: MetricsConfig) -> Result<Self, MetricsError> {
        #[cfg(feature = "metrics")]
        let inner = if config.mode == MetricsMode::Off {
            None
        } else {
            Some(MetricsInner::new()?)
        };
        let runtime = Self {
            config,
            #[cfg(feature = "metrics")]
            inner,
        };
        #[cfg(feature = "metrics")]
        runtime.start_sampler();
        Ok(runtime)
    }

    pub(crate) fn mode(&self) -> MetricsMode {
        self.config.mode
    }

    pub(crate) fn routes_visible(&self) -> bool {
        self.config.routes_visible
    }

    #[cfg(feature = "metrics-ui")]
    pub(crate) fn ui_enabled(&self) -> bool {
        self.config.mode == MetricsMode::Ui
    }

    pub(crate) fn collection_enabled(&self) -> bool {
        self.config.mode != MetricsMode::Off
    }

    pub(crate) fn track_listener(&self, listener: TcpListener) -> MetricsListener {
        MetricsListener {
            listener,
            metrics: self.clone(),
        }
    }

    fn connection_started(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner.connections.fetch_add(1, Ordering::Relaxed) + 1;
            ::metrics::gauge!("dbx_model_proxy_connections").set(active as f64);
        }
    }

    fn connection_finished(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner
                .connections
                .fetch_sub(1, Ordering::Relaxed)
                .saturating_sub(1);
            ::metrics::gauge!("dbx_model_proxy_connections").set(active as f64);
        }
    }

    pub(crate) fn request_started(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner.active_requests.fetch_add(1, Ordering::Relaxed) + 1;
            ::metrics::gauge!("dbx_model_proxy_active_requests").set(active as f64);
        }
    }

    pub(crate) fn request_finished(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner
                .active_requests
                .fetch_sub(1, Ordering::Relaxed)
                .saturating_sub(1);
            ::metrics::gauge!("dbx_model_proxy_active_requests").set(active as f64);
        }
    }

    pub(crate) fn stream_started(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner.active_streams.fetch_add(1, Ordering::Relaxed) + 1;
            ::metrics::gauge!("dbx_model_proxy_active_streams").set(active as f64);
        }
    }

    pub(crate) fn stream_finished(&self) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let active = inner
                .active_streams
                .fetch_sub(1, Ordering::Relaxed)
                .saturating_sub(1);
            ::metrics::gauge!("dbx_model_proxy_active_streams").set(active as f64);
        }
    }

    pub(crate) fn record_outcome(&self, outcome: &RequestOutcome) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_outcome(outcome);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = outcome;
    }

    pub(crate) fn record_transition(&self, model: &str, transition: AutoTransition) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_transition(model, transition);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = (model, transition);
    }

    pub(crate) fn record_upstream_429(&self, model: &str, input_token_limit: bool) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_upstream_429(model, input_token_limit);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = (model, input_token_limit);
    }

    pub(crate) fn record_in_band_rate_limit(&self, model: &str) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_in_band_rate_limit(model);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = model;
    }

    pub(crate) fn record_local_rate_limit(&self, model: &str, reason: &'static str) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_local_rate_limit(model, reason);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = (model, reason);
    }

    pub(crate) fn record_oversized(&self, model: &str) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_oversized(model);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = model;
    }

    pub(crate) fn record_transport_failure(&self, model: &str) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_transport_failure(model);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = model;
    }

    pub(crate) fn record_retry(&self, delay_source: &'static str, exhausted: bool) {
        #[cfg(feature = "metrics")]
        if self.inner.is_some() {
            if exhausted {
                ::metrics::counter!(
                    "dbx_model_proxy_retry_exhausted_total",
                    "delay_source" => delay_source
                )
                .increment(1);
            } else {
                ::metrics::counter!(
                    "dbx_model_proxy_retries_total",
                    "delay_source" => delay_source
                )
                .increment(1);
            }
        }
        #[cfg(not(feature = "metrics"))]
        let _ = (delay_source, exhausted);
    }

    pub(crate) fn snapshot(&self) -> MetricsSnapshot {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let mut snapshot = inner.snapshot();
            snapshot.mode = self.config.mode;
            return snapshot;
        }
        MetricsSnapshot::disabled(self.config.mode)
    }

    pub(crate) fn snapshot_for_model(&self, model: &str) -> MetricsSnapshot {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let mut snapshot = inner.snapshot_for_model(model);
            snapshot.mode = self.config.mode;
            return snapshot;
        }
        let _ = model;
        MetricsSnapshot::disabled(self.config.mode)
    }

    pub(crate) fn record_capacity_snapshots(&self, capacities: &[ThrottleModelSnapshot]) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_capacity_snapshots(capacities);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = capacities;
    }

    pub(crate) fn prometheus(&self) -> Option<String> {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            return Some(inner.prometheus.render());
        }
        None
    }

    #[cfg(feature = "metrics")]
    pub(crate) fn subscribe(&self) -> Option<broadcast::Receiver<String>> {
        self.inner.as_ref().map(|inner| inner.events.subscribe())
    }

    #[cfg(feature = "metrics")]
    fn start_sampler(&self) {
        let Some(inner) = self.inner.clone() else {
            return;
        };
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                inner.prometheus.run_upkeep();
                let snapshot = inner.snapshot();
                if let Ok(payload) = serde_json::to_string(&snapshot) {
                    let _ = inner.events.send(payload);
                }
            }
        });
    }
}

/// Socket address extracted from the tracked listener.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PeerAddr(pub(crate) SocketAddr);

/// Existing-listener wrapper that tracks accepted TCP connection lifetimes.
pub(crate) struct MetricsListener {
    listener: TcpListener,
    metrics: MetricsRuntime,
}

impl axum::serve::Listener for MetricsListener {
    type Io = MetricsStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, address) =
            <TcpListener as axum::serve::Listener>::accept(&mut self.listener).await;
        self.metrics.connection_started();
        (
            MetricsStream {
                stream,
                metrics: self.metrics.clone(),
            },
            address,
        )
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

impl<'a> axum::extract::connect_info::Connected<axum::serve::IncomingStream<'a, MetricsListener>>
    for PeerAddr
{
    fn connect_info(stream: axum::serve::IncomingStream<'a, MetricsListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

/// TCP stream wrapper whose drop marks a connection closed.
pub(crate) struct MetricsStream {
    stream: TcpStream,
    metrics: MetricsRuntime,
}

impl AsyncRead for MetricsStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}

impl AsyncWrite for MetricsStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.stream).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.stream).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}

impl Drop for MetricsStream {
    fn drop(&mut self) {
        self.metrics.connection_finished();
    }
}

/// Current dashboard and JSON endpoint payload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSnapshot {
    pub(crate) mode: MetricsMode,
    pub(crate) generated_at_ms: u64,
    pub(crate) uptime_seconds: u64,
    pub(crate) summary: SummarySnapshot,
    pub(crate) history: Vec<BucketSnapshot>,
    pub(crate) rollup_history: Vec<BucketSnapshot>,
    pub(crate) models: Vec<ModelSnapshot>,
    pub(crate) reasoning_levels: Vec<ReasoningLevelSnapshot>,
    pub(crate) rate_limit_events: Vec<RateLimitEvent>,
    pub(crate) retention: RetentionSnapshot,
}

impl MetricsSnapshot {
    fn disabled(mode: MetricsMode) -> Self {
        Self {
            mode,
            generated_at_ms: 0,
            uptime_seconds: 0,
            summary: SummarySnapshot::default(),
            history: Vec::new(),
            rollup_history: Vec::new(),
            models: Vec::new(),
            reasoning_levels: Vec::new(),
            rate_limit_events: Vec::new(),
            retention: RetentionSnapshot {
                detailed_resolution_seconds: 5,
                detailed_seconds: 3_600,
                rollup_resolution_seconds: 60,
                rollup_seconds: 86_400,
                model_series_limit: MODEL_SERIES_LIMIT,
                target_bytes: RETENTION_TARGET_BYTES,
                estimated_bytes: 0,
                process_local: true,
            },
        }
    }

    pub(crate) fn apply_capacity_snapshots(&mut self, capacities: &[ThrottleModelSnapshot]) {
        for capacity in capacities {
            let model = if let Some(model) = self
                .models
                .iter_mut()
                .find(|model| model.model == capacity.model)
            {
                model
            } else {
                self.models.push(ModelSnapshot::from_capacity(capacity));
                self.models.last_mut().expect("capacity model was appended")
            };
            model.queue_depth = capacity.queue_depth;
            model.queue_depth_max = model.queue_depth_max.max(capacity.queue_depth);
            model.limiter = if capacity.active {
                "enforced".to_owned()
            } else {
                "inactive".to_owned()
            };
            model.penalty_basis_points = capacity.penalty_basis_points;
            model.input_limit = capacity.input_limit;
            model.effective_input_budget = capacity.effective_input_budget;
            model.input_window_used = capacity.input_window_used;
        }
        self.models.sort_by(|left, right| {
            right
                .requests
                .cmp(&left.requests)
                .then_with(|| left.model.cmp(&right.model))
        });
        self.summary.active_models = self.models.len();
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarySnapshot {
    pub(crate) connections: u64,
    pub(crate) active_requests: u64,
    pub(crate) active_streams: u64,
    pub(crate) requests_per_minute: u64,
    pub(crate) tokens_per_minute: u64,
    pub(crate) p50_latency_ms: u64,
    pub(crate) p95_latency_ms: u64,
    pub(crate) p99_latency_ms: u64,
    pub(crate) rate_429_percent: f64,
    pub(crate) active_models: usize,
    pub(crate) total_requests: u64,
    pub(crate) total_rate_limited: u64,
    pub(crate) total_fallbacks: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BucketSnapshot {
    pub(crate) started_at_ms: u64,
    pub(crate) requests: u64,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) errors: u64,
    pub(crate) rate_limited: u64,
    pub(crate) average_latency_ms: u64,
    pub(crate) maximum_latency_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReasoningLevelSnapshot {
    pub(crate) level: String,
    pub(crate) requests: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSnapshot {
    pub(crate) model: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) history: Vec<BucketSnapshot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) rollup_history: Vec<BucketSnapshot>,
    pub(crate) requests: u64,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) errors: u64,
    pub(crate) rate_limited: u64,
    pub(crate) oversized_rejections: u64,
    pub(crate) retries: u64,
    pub(crate) fallbacks: u64,
    pub(crate) queue_wait_ms: u64,
    pub(crate) queue_depth: u64,
    pub(crate) queue_depth_max: u64,
    pub(crate) p50_latency_ms: u64,
    pub(crate) p95_latency_ms: u64,
    pub(crate) p99_latency_ms: u64,
    pub(crate) limiter: String,
    pub(crate) penalty_basis_points: u16,
    pub(crate) input_limit: Option<u64>,
    pub(crate) effective_input_budget: Option<u64>,
    pub(crate) input_window_used: Option<u64>,
    pub(crate) reasoning_levels: Vec<ReasoningLevelSnapshot>,
}

impl ModelSnapshot {
    fn from_capacity(capacity: &ThrottleModelSnapshot) -> Self {
        Self {
            model: capacity.model.clone(),
            history: Vec::new(),
            rollup_history: Vec::new(),
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            errors: 0,
            rate_limited: 0,
            oversized_rejections: 0,
            retries: 0,
            fallbacks: 0,
            queue_wait_ms: 0,
            queue_depth: capacity.queue_depth,
            queue_depth_max: capacity.queue_depth,
            p50_latency_ms: 0,
            p95_latency_ms: 0,
            p99_latency_ms: 0,
            limiter: if capacity.active {
                "enforced".to_owned()
            } else {
                "inactive".to_owned()
            },
            penalty_basis_points: capacity.penalty_basis_points,
            input_limit: capacity.input_limit,
            effective_input_budget: capacity.effective_input_budget,
            input_window_used: capacity.input_window_used,
            reasoning_levels: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitEvent {
    pub(crate) at_ms: u64,
    pub(crate) model: String,
    pub(crate) transition: AutoTransition,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionSnapshot {
    pub(crate) detailed_resolution_seconds: u64,
    pub(crate) detailed_seconds: u64,
    pub(crate) rollup_resolution_seconds: u64,
    pub(crate) rollup_seconds: u64,
    pub(crate) model_series_limit: usize,
    pub(crate) target_bytes: u64,
    pub(crate) estimated_bytes: u64,
    pub(crate) process_local: bool,
}

#[cfg(feature = "metrics")]
struct MetricsInner {
    started: tokio::time::Instant,
    store: Mutex<MetricsStore>,
    connections: AtomicU64,
    active_requests: AtomicU64,
    active_streams: AtomicU64,
    events: broadcast::Sender<String>,
    prometheus: PrometheusHandle,
}

#[cfg(feature = "metrics")]
impl MetricsInner {
    fn new() -> Result<Arc<Self>, MetricsError> {
        let (events, _) = broadcast::channel(8);
        Ok(Arc::new(Self {
            started: tokio::time::Instant::now(),
            store: Mutex::new(MetricsStore::new()),
            connections: AtomicU64::new(0),
            active_requests: AtomicU64::new(0),
            active_streams: AtomicU64::new(0),
            events,
            prometheus: prometheus_handle()?,
        }))
    }

    fn record_outcome(&self, outcome: &RequestOutcome) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_outcome(elapsed_ms, outcome);
        let status_class = format!("{}xx", outcome.status.as_u16() / 100);
        let streaming = if outcome.streaming { "true" } else { "false" };
        let client = outcome
            .client_wire
            .map(|wire| format!("{wire:?}").to_ascii_lowercase())
            .unwrap_or_else(|| "embedding".to_owned());
        let target = outcome
            .target
            .map(|wire| format!("{wire:?}").to_ascii_lowercase())
            .unwrap_or_else(|| "invocations".to_owned());
        ::metrics::counter!(
            "dbx_model_proxy_requests_total",
            "route" => outcome.route,
            "model" => model_label.clone(),
            "status_class" => status_class,
            "streaming" => streaming,
            "client_protocol" => client,
            "target_protocol" => target,
        )
        .increment(1);
        if let Some(reasoning_setting) = outcome.reasoning_setting {
            ::metrics::counter!(
                "dbx_model_proxy_reasoning_requests_total",
                "reasoning_level" => reasoning_setting.label()
            )
            .increment(1);
        }
        if outcome.fallback_step > 0 {
            ::metrics::counter!(
                "dbx_model_proxy_model_fallbacks_total",
                "model" => model_label.clone()
            )
            .increment(1);
        }
        ::metrics::counter!(
            "dbx_model_proxy_input_bytes_total",
            "model" => model_label.clone()
        )
        .increment(outcome.request_bytes as u64);
        ::metrics::counter!(
            "dbx_model_proxy_output_bytes_total",
            "model" => model_label.clone()
        )
        .increment(outcome.response_bytes);
        ::metrics::counter!(
            "dbx_model_proxy_input_tokens_total",
            "model" => model_label.clone()
        )
        .increment(outcome.usage.input);
        ::metrics::counter!(
            "dbx_model_proxy_output_tokens_total",
            "model" => model_label.clone()
        )
        .increment(outcome.usage.output);
        ::metrics::counter!(
            "dbx_model_proxy_estimated_input_tokens_total",
            "model" => model_label.clone()
        )
        .increment(outcome.throttle.estimated_input_tokens);
        ::metrics::counter!(
            "dbx_model_proxy_reserved_output_tokens_total",
            "model" => model_label.clone()
        )
        .increment(outcome.throttle.reserved_output_tokens);
        ::metrics::histogram!(
            "dbx_model_proxy_request_duration_seconds",
            "route" => outcome.route,
            "model" => model_label.clone()
        )
        .record(outcome.duration_ms as f64 / 1_000.0);
        ::metrics::histogram!("dbx_model_proxy_admission_queue_depth")
            .record(outcome.throttle.queue_depth as f64);
        ::metrics::gauge!(
            "dbx_model_proxy_current_queue_depth",
            "model" => model_label.clone()
        )
        .set(outcome.throttle.current_queue_depth() as f64);
        if let Some(input_limit) = outcome.throttle.input_limit {
            ::metrics::gauge!(
                "dbx_model_proxy_input_limit_tokens",
                "model" => model_label.clone()
            )
            .set(input_limit as f64);
        }
        if let Some(input_budget) = outcome.throttle.input_window_budget {
            ::metrics::gauge!(
                "dbx_model_proxy_input_window_used_tokens",
                "model" => model_label.clone()
            )
            .set(
                outcome
                    .throttle
                    .input_window_used_before
                    .saturating_add(outcome.throttle.reserved_input_tokens) as f64,
            );
            ::metrics::gauge!(
                "dbx_model_proxy_effective_input_budget_tokens",
                "model" => model_label
            )
            .set(input_budget as f64);
        }
    }

    fn record_transition(&self, model: &str, transition: AutoTransition) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_transition(elapsed_ms, model, transition);
        ::metrics::counter!(
            "dbx_model_proxy_rate_limit_transitions_total",
            "transition" => format!("{:?}", transition.kind).to_ascii_lowercase()
        )
        .increment(1);
        ::metrics::gauge!(
            "dbx_model_proxy_rate_limit_penalty_basis_points",
            "model" => model_label.clone()
        )
        .set(f64::from(transition.penalty_basis_points));
        ::metrics::gauge!(
            "dbx_model_proxy_effective_input_budget_tokens",
            "model" => model_label
        )
        .set(transition.effective_input_budget as f64);
    }

    fn record_upstream_429(&self, model: &str, input_token_limit: bool) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_rate_limited(elapsed_ms, model);
        ::metrics::counter!(
            "dbx_model_proxy_upstream_429_total",
            "model" => model_label,
            "input_token_limit" => if input_token_limit { "true" } else { "false" }
        )
        .increment(1);
    }

    fn record_in_band_rate_limit(&self, model: &str) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_rate_limited(elapsed_ms, model);
        ::metrics::counter!(
            "dbx_model_proxy_stream_rate_limits_total",
            "model" => model_label
        )
        .increment(1);
    }

    fn record_local_rate_limit(&self, model: &str, reason: &'static str) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_rate_limited(elapsed_ms, model);
        ::metrics::counter!(
            "dbx_model_proxy_local_rate_limits_total",
            "model" => model_label,
            "reason" => reason
        )
        .increment(1);
    }

    fn record_oversized(&self, model: &str) {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let mut store = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned");
        store.record_rate_limited(elapsed_ms, model);
        let model_label = store.record_oversized(model);
        drop(store);
        ::metrics::counter!(
            "dbx_model_proxy_oversized_rejections_total",
            "model" => model_label
        )
        .increment(1);
    }

    fn record_transport_failure(&self, model: &str) {
        let model_label = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_transport_failure(model);
        ::metrics::counter!(
            "dbx_model_proxy_transport_failures_total",
            "model" => model_label
        )
        .increment(1);
    }

    fn record_capacity_snapshots(&self, capacities: &[ThrottleModelSnapshot]) {
        for capacity in capacities {
            let model = {
                let mut store = self
                    .store
                    .lock()
                    .expect("metrics store lock is not poisoned");
                let label = store.model_label(&capacity.model);
                if label != "other" {
                    store
                        .models
                        .entry(label.clone())
                        .or_insert_with(|| ModelMetrics::new(&label));
                }
                label
            };
            ::metrics::gauge!(
                "dbx_model_proxy_current_queue_depth",
                "model" => model.clone()
            )
            .set(capacity.queue_depth as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_penalty_basis_points",
                "model" => model.clone()
            )
            .set(f64::from(capacity.penalty_basis_points));
            if let Some(input_limit) = capacity.input_limit {
                ::metrics::gauge!(
                    "dbx_model_proxy_input_limit_tokens",
                    "model" => model.clone()
                )
                .set(input_limit as f64);
            }
            if let Some(input_budget) = capacity.effective_input_budget {
                ::metrics::gauge!(
                    "dbx_model_proxy_effective_input_budget_tokens",
                    "model" => model.clone()
                )
                .set(input_budget as f64);
            }
            if let Some(input_used) = capacity.input_window_used {
                ::metrics::gauge!(
                    "dbx_model_proxy_input_window_used_tokens",
                    "model" => model
                )
                .set(input_used as f64);
            }
        }
    }

    fn snapshot(&self) -> MetricsSnapshot {
        self.snapshot_with_model(None)
    }

    fn snapshot_for_model(&self, model: &str) -> MetricsSnapshot {
        self.snapshot_with_model(Some(model))
    }

    fn snapshot_with_model(&self, model: Option<&str>) -> MetricsSnapshot {
        let elapsed_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let connections = self.connections.load(Ordering::Relaxed);
        let active_requests = self.active_requests.load(Ordering::Relaxed);
        let active_streams = self.active_streams.load(Ordering::Relaxed);
        self.store
            .lock()
            .expect("metrics store lock is not poisoned")
            .snapshot(
                elapsed_ms,
                connections,
                active_requests,
                active_streams,
                model,
            )
    }
}

#[cfg(feature = "metrics")]
fn prometheus_handle() -> Result<PrometheusHandle, MetricsError> {
    static HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();
    static INSTALL: Mutex<()> = Mutex::new(());
    if let Some(handle) = HANDLE.get() {
        return Ok(handle.clone());
    }
    let _install = INSTALL
        .lock()
        .expect("metrics recorder lock is not poisoned");
    if let Some(handle) = HANDLE.get() {
        return Ok(handle.clone());
    }
    let handle = PrometheusBuilder::new()
        .install_recorder()
        .map_err(|error| MetricsError::Recorder(error.to_string()))?;
    let _ = HANDLE.set(handle.clone());
    Ok(handle)
}

#[cfg(feature = "metrics")]
#[derive(Clone, Debug, Default)]
struct ReasoningCounts {
    requests: [u64; ReasoningSetting::COUNT],
}

#[cfg(feature = "metrics")]
impl ReasoningCounts {
    fn record(&mut self, setting: ReasoningSetting) {
        let index = setting.index();
        self.requests[index] = self.requests[index].saturating_add(1);
    }

    fn snapshot(&self) -> Vec<ReasoningLevelSnapshot> {
        ReasoningSetting::ALL
            .into_iter()
            .filter_map(|setting| {
                let requests = self.requests[setting.index()];
                (requests > 0).then(|| ReasoningLevelSnapshot {
                    level: setting.label().to_owned(),
                    requests,
                })
            })
            .collect()
    }
}

#[cfg(feature = "metrics")]
#[derive(Debug)]
struct MetricsStore {
    total_requests: u64,
    total_rate_limited: u64,
    total_fallbacks: u64,
    latency: Histogram<u64>,
    detailed: VecDeque<Bucket>,
    detailed_current: Bucket,
    rollups: VecDeque<Bucket>,
    rollup_current: Bucket,
    models: HashMap<String, ModelMetrics>,
    other: ModelMetrics,
    reasoning: ReasoningCounts,
    rate_limit_events: VecDeque<RateLimitEvent>,
}

#[cfg(feature = "metrics")]
impl MetricsStore {
    fn new() -> Self {
        Self {
            total_requests: 0,
            total_rate_limited: 0,
            total_fallbacks: 0,
            latency: latency_histogram(),
            detailed: VecDeque::with_capacity(DETAILED_BUCKET_LIMIT),
            detailed_current: Bucket::default(),
            rollups: VecDeque::with_capacity(ROLLUP_BUCKET_LIMIT),
            rollup_current: Bucket::default(),
            models: HashMap::with_capacity(MODEL_SERIES_LIMIT),
            other: ModelMetrics::new("other"),
            reasoning: ReasoningCounts::default(),
            rate_limit_events: VecDeque::with_capacity(RATE_LIMIT_EVENT_LIMIT),
        }
    }

    fn record_outcome(&mut self, elapsed_ms: u64, outcome: &RequestOutcome) -> String {
        self.advance(elapsed_ms);
        self.total_requests = self.total_requests.saturating_add(1);
        self.total_fallbacks = self
            .total_fallbacks
            .saturating_add(u64::from(outcome.fallback_step > 0));
        let _ = self.latency.record(outcome.duration_ms);
        self.detailed_current.record(outcome);
        self.rollup_current.record(outcome);
        if let Some(reasoning_setting) = outcome.reasoning_setting {
            self.reasoning.record(reasoning_setting);
        }

        let model_label = if self.models.contains_key(&outcome.resolved_model)
            || self.models.len() < MODEL_SERIES_LIMIT
        {
            outcome.resolved_model.clone()
        } else {
            "other".to_owned()
        };
        if model_label == "other" {
            self.other.record(elapsed_ms, outcome);
        } else {
            self.models
                .entry(model_label.clone())
                .or_insert_with(|| ModelMetrics::new(&model_label))
                .record(elapsed_ms, outcome);
        }
        model_label
    }

    fn record_rate_limited(&mut self, elapsed_ms: u64, model: &str) -> String {
        self.advance(elapsed_ms);
        self.total_rate_limited = self.total_rate_limited.saturating_add(1);
        self.detailed_current.rate_limited = self.detailed_current.rate_limited.saturating_add(1);
        self.rollup_current.rate_limited = self.rollup_current.rate_limited.saturating_add(1);
        let label = self.model_label(model);
        if label == "other" {
            self.other.record_rate_limited(elapsed_ms);
        } else {
            let target = self
                .models
                .entry(label.clone())
                .or_insert_with(|| ModelMetrics::new(&label));
            target.record_rate_limited(elapsed_ms);
        }
        label
    }

    fn record_oversized(&mut self, model: &str) -> String {
        let label = self.model_label(model);
        if label == "other" {
            self.other.oversized_rejections = self.other.oversized_rejections.saturating_add(1);
        } else {
            let target = self
                .models
                .entry(label.clone())
                .or_insert_with(|| ModelMetrics::new(&label));
            target.oversized_rejections = target.oversized_rejections.saturating_add(1);
        }
        label
    }

    fn record_transport_failure(&mut self, model: &str) -> String {
        let label = self.model_label(model);
        if label == "other" {
            self.other.errors = self.other.errors.saturating_add(1);
        } else {
            let target = self
                .models
                .entry(label.clone())
                .or_insert_with(|| ModelMetrics::new(&label));
            target.errors = target.errors.saturating_add(1);
        }
        label
    }

    fn model_label(&self, model: &str) -> String {
        if self.models.contains_key(model) || self.models.len() < MODEL_SERIES_LIMIT {
            model.to_owned()
        } else {
            "other".to_owned()
        }
    }

    fn record_transition(
        &mut self,
        elapsed_ms: u64,
        model: &str,
        transition: AutoTransition,
    ) -> String {
        if self.rate_limit_events.len() == RATE_LIMIT_EVENT_LIMIT {
            self.rate_limit_events.pop_front();
        }
        self.rate_limit_events.push_back(RateLimitEvent {
            at_ms: elapsed_ms,
            model: model.to_owned(),
            transition,
        });
        let label = self.model_label(model);
        let limiter = limiter_state(transition);
        if label == "other" {
            self.other.limiter = limiter.to_owned();
            self.other.penalty_basis_points = transition.penalty_basis_points;
            self.other.input_limit = Some(transition.base_input_budget);
            self.other.effective_input_budget = Some(transition.effective_input_budget);
            self.other.limiter_observed = true;
            if transition.kind == AutoTransitionKind::Deactivated {
                self.other.input_window_used = Some(0);
            }
        } else {
            let target = self
                .models
                .entry(label.clone())
                .or_insert_with(|| ModelMetrics::new(&label));
            target.limiter = limiter.to_owned();
            target.penalty_basis_points = transition.penalty_basis_points;
            target.input_limit = Some(transition.base_input_budget);
            target.effective_input_budget = Some(transition.effective_input_budget);
            target.limiter_observed = true;
            if transition.kind == AutoTransitionKind::Deactivated {
                target.input_window_used = Some(0);
            }
        }
        label
    }

    fn advance(&mut self, elapsed_ms: u64) {
        advance_bucket(
            &mut self.detailed,
            &mut self.detailed_current,
            elapsed_ms,
            5_000,
            DETAILED_BUCKET_LIMIT,
        );
        advance_bucket(
            &mut self.rollups,
            &mut self.rollup_current,
            elapsed_ms,
            60_000,
            ROLLUP_BUCKET_LIMIT,
        );
    }

    fn snapshot(
        &mut self,
        elapsed_ms: u64,
        connections: u64,
        active_requests: u64,
        active_streams: u64,
        selected_model: Option<&str>,
    ) -> MetricsSnapshot {
        self.advance(elapsed_ms);
        let mut history = self
            .detailed
            .iter()
            .map(Bucket::snapshot)
            .collect::<Vec<_>>();
        history.push(self.detailed_current.snapshot());
        let mut rollup_history = self
            .rollups
            .iter()
            .map(Bucket::snapshot)
            .collect::<Vec<_>>();
        rollup_history.push(self.rollup_current.snapshot());
        let minute = recent_totals(&history, elapsed_ms.saturating_sub(60_000));
        let mut models = self
            .models
            .values_mut()
            .map(|model| {
                let include_history = selected_model == Some(model.model.as_str());
                model.snapshot(elapsed_ms, include_history)
            })
            .collect::<Vec<_>>();
        if self.other.requests > 0
            || self.other.rate_limited > 0
            || self.other.oversized_rejections > 0
        {
            models.push(
                self.other
                    .snapshot(elapsed_ms, selected_model == Some("other")),
            );
        }
        models.sort_by(|left, right| {
            right
                .requests
                .cmp(&left.requests)
                .then_with(|| left.model.cmp(&right.model))
        });
        let rate_429_percent = if minute.requests == 0 {
            0.0
        } else {
            minute.rate_limited as f64 * 100.0 / minute.requests as f64
        };
        let estimated_bytes =
            estimated_retained_bytes(history.len(), rollup_history.len(), models.len());
        MetricsSnapshot {
            mode: if cfg!(feature = "metrics-ui") {
                MetricsMode::Ui
            } else {
                MetricsMode::Collect
            },
            generated_at_ms: elapsed_ms,
            uptime_seconds: elapsed_ms / 1_000,
            summary: SummarySnapshot {
                connections,
                active_requests,
                active_streams,
                requests_per_minute: minute.requests,
                tokens_per_minute: minute.input_tokens.saturating_add(minute.output_tokens),
                p50_latency_ms: quantile(&self.latency, 0.50),
                p95_latency_ms: quantile(&self.latency, 0.95),
                p99_latency_ms: quantile(&self.latency, 0.99),
                rate_429_percent,
                active_models: self.models.len(),
                total_requests: self.total_requests,
                total_rate_limited: self.total_rate_limited,
                total_fallbacks: self.total_fallbacks,
            },
            history,
            rollup_history,
            models,
            reasoning_levels: self.reasoning.snapshot(),
            rate_limit_events: self.rate_limit_events.iter().cloned().collect(),
            retention: RetentionSnapshot {
                detailed_resolution_seconds: 5,
                detailed_seconds: 3_600,
                rollup_resolution_seconds: 60,
                rollup_seconds: 86_400,
                model_series_limit: MODEL_SERIES_LIMIT,
                target_bytes: RETENTION_TARGET_BYTES,
                estimated_bytes,
                process_local: true,
            },
        }
    }
}

#[cfg(feature = "metrics")]
#[derive(Clone, Debug, Default)]
struct Bucket {
    started_at_ms: u64,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    errors: u64,
    rate_limited: u64,
    latency_total_ms: u64,
    latency_maximum_ms: u64,
}

#[cfg(feature = "metrics")]
impl Bucket {
    fn record(&mut self, outcome: &RequestOutcome) {
        self.requests = self.requests.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(if outcome.usage.reported {
            outcome.usage.input
        } else {
            outcome.throttle.estimated_input_tokens
        });
        self.output_tokens = self
            .output_tokens
            .saturating_add(if outcome.usage.reported {
                outcome.usage.output
            } else {
                outcome.throttle.reserved_output_tokens
            });
        self.errors = self.errors.saturating_add(u64::from(
            outcome.failed || outcome.status.is_server_error(),
        ));
        self.latency_total_ms = self.latency_total_ms.saturating_add(outcome.duration_ms);
        self.latency_maximum_ms = self.latency_maximum_ms.max(outcome.duration_ms);
    }

    fn snapshot(&self) -> BucketSnapshot {
        BucketSnapshot {
            started_at_ms: self.started_at_ms,
            requests: self.requests,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            errors: self.errors,
            rate_limited: self.rate_limited,
            average_latency_ms: self
                .latency_total_ms
                .checked_div(self.requests)
                .unwrap_or_default(),
            maximum_latency_ms: self.latency_maximum_ms,
        }
    }
}

#[cfg(feature = "metrics")]
#[derive(Debug)]
struct ModelMetrics {
    model: String,
    detailed: VecDeque<Bucket>,
    detailed_current: Bucket,
    rollups: VecDeque<Bucket>,
    rollup_current: Bucket,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    errors: u64,
    rate_limited: u64,
    oversized_rejections: u64,
    retries: u64,
    fallbacks: u64,
    queue_wait_ms: u64,
    queue_depth: u64,
    queue_depth_max: u64,
    latency: Histogram<u64>,
    limiter: String,
    limiter_observed: bool,
    penalty_basis_points: u16,
    input_limit: Option<u64>,
    effective_input_budget: Option<u64>,
    input_window_used: Option<u64>,
    reasoning: ReasoningCounts,
}

#[cfg(feature = "metrics")]
impl ModelMetrics {
    fn new(model: &str) -> Self {
        Self {
            model: model.to_owned(),
            detailed: VecDeque::with_capacity(DETAILED_BUCKET_LIMIT),
            detailed_current: Bucket::default(),
            rollups: VecDeque::with_capacity(ROLLUP_BUCKET_LIMIT),
            rollup_current: Bucket::default(),
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            errors: 0,
            rate_limited: 0,
            oversized_rejections: 0,
            retries: 0,
            fallbacks: 0,
            queue_wait_ms: 0,
            queue_depth: 0,
            queue_depth_max: 0,
            latency: latency_histogram(),
            limiter: "inactive".to_owned(),
            limiter_observed: false,
            penalty_basis_points: 0,
            input_limit: None,
            effective_input_budget: None,
            input_window_used: None,
            reasoning: ReasoningCounts::default(),
        }
    }

    fn record(&mut self, elapsed_ms: u64, outcome: &RequestOutcome) {
        self.advance(elapsed_ms);
        self.detailed_current.record(outcome);
        self.rollup_current.record(outcome);
        self.requests = self.requests.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(if outcome.usage.reported {
            outcome.usage.input
        } else {
            outcome.throttle.estimated_input_tokens
        });
        self.output_tokens = self
            .output_tokens
            .saturating_add(if outcome.usage.reported {
                outcome.usage.output
            } else {
                outcome.throttle.reserved_output_tokens
            });
        self.errors = self.errors.saturating_add(u64::from(
            outcome.failed || outcome.status.is_server_error(),
        ));
        self.retries = self
            .retries
            .saturating_add(u64::from(outcome.upstream_attempt.saturating_sub(1)));
        self.fallbacks = self
            .fallbacks
            .saturating_add(u64::from(outcome.fallback_step > 0));
        self.queue_wait_ms = self
            .queue_wait_ms
            .saturating_add(outcome.throttle.wait.as_millis().min(u128::from(u64::MAX)) as u64);
        self.queue_depth = outcome.throttle.current_queue_depth();
        self.queue_depth_max = self.queue_depth_max.max(outcome.throttle.queue_depth);
        if let Some(reasoning_setting) = outcome.reasoning_setting {
            self.reasoning.record(reasoning_setting);
        }
        let _ = self.latency.record(outcome.duration_ms);
        if !self.limiter_observed && outcome.throttle.active {
            self.limiter = "enforced".to_owned();
            self.penalty_basis_points = outcome.throttle.penalty_basis_points;
            self.input_limit = outcome.throttle.input_limit;
            self.effective_input_budget = outcome.throttle.input_window_budget;
        }
        if self.limiter != "inactive" {
            self.input_window_used = outcome.throttle.input_window_budget.map(|_| {
                outcome
                    .throttle
                    .input_window_used_before
                    .saturating_add(outcome.throttle.reserved_input_tokens)
            });
        }
    }

    fn record_rate_limited(&mut self, elapsed_ms: u64) {
        self.advance(elapsed_ms);
        self.rate_limited = self.rate_limited.saturating_add(1);
        self.detailed_current.rate_limited = self.detailed_current.rate_limited.saturating_add(1);
        self.rollup_current.rate_limited = self.rollup_current.rate_limited.saturating_add(1);
    }

    fn advance(&mut self, elapsed_ms: u64) {
        advance_bucket(
            &mut self.detailed,
            &mut self.detailed_current,
            elapsed_ms,
            5_000,
            DETAILED_BUCKET_LIMIT,
        );
        advance_bucket(
            &mut self.rollups,
            &mut self.rollup_current,
            elapsed_ms,
            60_000,
            ROLLUP_BUCKET_LIMIT,
        );
    }

    fn snapshot(&mut self, elapsed_ms: u64, include_history: bool) -> ModelSnapshot {
        self.advance(elapsed_ms);
        let (history, rollup_history) = if include_history {
            let mut history = self
                .detailed
                .iter()
                .map(Bucket::snapshot)
                .collect::<Vec<_>>();
            history.push(self.detailed_current.snapshot());
            let mut rollup_history = self
                .rollups
                .iter()
                .map(Bucket::snapshot)
                .collect::<Vec<_>>();
            rollup_history.push(self.rollup_current.snapshot());
            (history, rollup_history)
        } else {
            (Vec::new(), Vec::new())
        };
        ModelSnapshot {
            model: self.model.clone(),
            history,
            rollup_history,
            requests: self.requests,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            errors: self.errors,
            rate_limited: self.rate_limited,
            oversized_rejections: self.oversized_rejections,
            retries: self.retries,
            fallbacks: self.fallbacks,
            queue_wait_ms: self.queue_wait_ms,
            queue_depth: self.queue_depth,
            queue_depth_max: self.queue_depth_max,
            p50_latency_ms: quantile(&self.latency, 0.50),
            p95_latency_ms: quantile(&self.latency, 0.95),
            p99_latency_ms: quantile(&self.latency, 0.99),
            limiter: self.limiter.clone(),
            penalty_basis_points: self.penalty_basis_points,
            input_limit: self.input_limit,
            effective_input_budget: self.effective_input_budget,
            input_window_used: self.input_window_used,
            reasoning_levels: self.reasoning.snapshot(),
        }
    }
}

#[cfg(feature = "metrics")]
fn limiter_state(transition: AutoTransition) -> &'static str {
    match transition.kind {
        AutoTransitionKind::Deactivated => "inactive",
        AutoTransitionKind::Activated
        | AutoTransitionKind::Tightened
        | AutoTransitionKind::Relaxed
        | AutoTransitionKind::Reactivated => "enforced",
    }
}

#[cfg(feature = "metrics")]
fn latency_histogram() -> Histogram<u64> {
    Histogram::new_with_max(24 * 60 * 60 * 1_000, 3).expect("valid latency histogram bounds")
}

#[cfg(feature = "metrics")]
fn quantile(histogram: &Histogram<u64>, quantile: f64) -> u64 {
    if histogram.is_empty() {
        0
    } else {
        histogram.value_at_quantile(quantile)
    }
}

#[cfg(feature = "metrics")]
fn advance_bucket(
    history: &mut VecDeque<Bucket>,
    current: &mut Bucket,
    elapsed_ms: u64,
    resolution_ms: u64,
    limit: usize,
) {
    let start = elapsed_ms / resolution_ms * resolution_ms;
    if current.started_at_ms == start {
        return;
    }
    if current.requests > 0 || current.started_at_ms > 0 {
        if history.len() == limit {
            history.pop_front();
        }
        history.push_back(std::mem::take(current));
    }
    current.started_at_ms = start;
}

#[cfg(feature = "metrics")]
fn recent_totals(history: &[BucketSnapshot], since_ms: u64) -> BucketSnapshot {
    history
        .iter()
        .filter(|bucket| bucket.started_at_ms >= since_ms)
        .fold(BucketSnapshot::default(), |mut total, bucket| {
            total.requests = total.requests.saturating_add(bucket.requests);
            total.input_tokens = total.input_tokens.saturating_add(bucket.input_tokens);
            total.output_tokens = total.output_tokens.saturating_add(bucket.output_tokens);
            total.errors = total.errors.saturating_add(bucket.errors);
            total.rate_limited = total.rate_limited.saturating_add(bucket.rate_limited);
            total
        })
}

#[cfg(feature = "metrics")]
fn estimated_retained_bytes(detailed: usize, rollups: usize, models: usize) -> u64 {
    let bucket_bytes = detailed.saturating_add(rollups) as u64 * 96;
    let model_buckets = bucket_bytes.saturating_mul(models as u64);
    let model_histograms = models as u64 * 192 * 1024;
    bucket_bytes
        .saturating_add(model_buckets)
        .saturating_add(model_histograms)
        .saturating_add((RATE_LIMIT_EVENT_LIMIT * 256) as u64)
        .min(RETENTION_TARGET_BYTES)
}

#[cfg(feature = "metrics-ui")]
#[derive(RustEmbed)]
#[folder = "metrics-ui/dist/"]
struct DashboardAssets;

#[cfg(feature = "metrics-ui")]
pub(crate) struct DashboardAsset {
    pub(crate) body: std::borrow::Cow<'static, [u8]>,
    pub(crate) content_type: &'static str,
    pub(crate) immutable: bool,
}

#[cfg(feature = "metrics-ui")]
pub(crate) fn dashboard_asset(path: &str) -> Option<DashboardAsset> {
    let normalized = if path.is_empty() { "index.html" } else { path };
    let asset = DashboardAssets::get(normalized)?;
    Some(DashboardAsset {
        body: asset.data,
        content_type: mime_guess::from_path(normalized)
            .first_raw()
            .unwrap_or("application/octet-stream"),
        immutable: normalized
            .split('.')
            .any(|part| part.len() == 8 && part.bytes().all(|byte| byte.is_ascii_hexdigit())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_aliases_and_build_defaults_are_stable() {
        assert_eq!(
            "true".parse::<MetricsOption>().unwrap(),
            MetricsOption::Fullest
        );
        assert_eq!(
            "false".parse::<MetricsOption>().unwrap(),
            MetricsOption::Off
        );
        assert_eq!(
            "collect".parse::<MetricsOption>().unwrap(),
            MetricsOption::Collect
        );
        assert_eq!(
            default_metrics_option(),
            if cfg!(feature = "metrics-ui") {
                MetricsOption::Ui
            } else if cfg!(feature = "metrics") {
                MetricsOption::Collect
            } else {
                MetricsOption::Off
            }
        );
    }

    #[test]
    fn non_loopback_listener_requires_public_acknowledgement() {
        let host = "0.0.0.0".parse().unwrap();
        let config = MetricsConfig::resolve(default_metrics_option(), host, false).unwrap();
        assert!(!config.routes_visible);
        let public = MetricsConfig::resolve(default_metrics_option(), host, true).unwrap();
        assert_eq!(public.routes_visible, public.mode != MetricsMode::Off);
    }

    #[cfg(not(feature = "metrics"))]
    #[test]
    fn metrics_free_build_rejects_collection() {
        let host = "127.0.0.1".parse().unwrap();
        assert!(matches!(
            MetricsConfig::resolve(MetricsOption::Fullest, host, false),
            Err(MetricsError::CollectionUnavailable)
        ));
        assert_eq!(
            MetricsConfig::resolve(MetricsOption::Off, host, false)
                .unwrap()
                .mode,
            MetricsMode::Off
        );
    }

    #[cfg(feature = "metrics")]
    #[test]
    fn model_series_and_history_are_bounded() {
        let mut store = MetricsStore::new();
        for index in 0..40 {
            let outcome = fixture_outcome(format!("model-{index}"));
            store.record_outcome(index * 5_000, &outcome);
        }
        let snapshot = store.snapshot(200_000, 0, 0, 0, Some("model-0"));
        assert_eq!(store.models.len(), MODEL_SERIES_LIMIT);
        assert!(snapshot.models.iter().any(|model| model.model == "other"));
        assert!(snapshot.history.len() <= DETAILED_BUCKET_LIMIT + 1);
        let selected = snapshot
            .models
            .iter()
            .find(|model| model.model == "model-0")
            .unwrap();
        assert!(!selected.history.is_empty());
        assert!(selected.history.len() <= DETAILED_BUCKET_LIMIT + 1);
        assert!(selected.rollup_history.len() <= ROLLUP_BUCKET_LIMIT + 1);
        assert!(snapshot
            .models
            .iter()
            .filter(|model| model.model != "model-0")
            .all(|model| model.history.is_empty() && model.rollup_history.is_empty()));
        assert!(snapshot.retention.estimated_bytes <= RETENTION_TARGET_BYTES);
    }

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn snapshot_sse_and_prometheus_share_one_recorded_outcome() {
        let runtime = MetricsRuntime::new(MetricsConfig {
            mode: MetricsMode::Collect,
            routes_visible: true,
        })
        .unwrap();
        let mut receiver = runtime.subscribe().unwrap();
        let mut outcome = fixture_outcome("model".to_owned());
        outcome.fallback_step = 1;
        runtime.record_outcome(&outcome);
        runtime.record_upstream_429("model", true);
        runtime.record_oversized("model");
        runtime.record_local_rate_limit("model", "wait-budget");
        runtime.record_transition(
            "model",
            AutoTransition {
                kind: AutoTransitionKind::Activated,
                penalty_basis_points: 1_000,
                base_input_budget: 200_000,
                effective_input_budget: 180_000,
            },
        );

        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.summary.total_requests, 1);
        assert_eq!(snapshot.summary.total_rate_limited, 3);
        assert_eq!(snapshot.summary.total_fallbacks, 1);
        assert_eq!(snapshot.models[0].requests, 1);
        assert_eq!(snapshot.models[0].fallbacks, 1);
        assert!(snapshot.models[0].history.is_empty());
        assert_eq!(snapshot.models[0].rate_limited, 3);
        assert_eq!(snapshot.models[0].oversized_rejections, 1);
        assert_eq!(snapshot.reasoning_levels[0].level, "high");
        assert_eq!(snapshot.reasoning_levels[0].requests, 1);
        assert_eq!(snapshot.models[0].reasoning_levels[0].level, "high");
        assert_eq!(snapshot.models[0].limiter, "enforced");
        assert_eq!(snapshot.models[0].penalty_basis_points, 1_000);
        assert_eq!(snapshot.models[0].effective_input_budget, Some(180_000));
        let model_snapshot = runtime.snapshot_for_model("model");
        assert!(!model_snapshot.models[0].history.is_empty());
        let prometheus = runtime.prometheus().unwrap();
        assert!(prometheus.contains("dbx_model_proxy_requests_total"));
        assert!(prometheus.contains("dbx_model_proxy_rate_limit_penalty_basis_points"));
        assert!(prometheus.contains("dbx_model_proxy_effective_input_budget_tokens"));
        assert!(prometheus.contains("dbx_model_proxy_model_fallbacks_total"));
        assert!(prometheus.contains("dbx_model_proxy_local_rate_limits_total"));

        runtime.record_transition(
            "model",
            AutoTransition {
                kind: AutoTransitionKind::Deactivated,
                penalty_basis_points: 0,
                base_input_budget: 200_000,
                effective_input_budget: 200_000,
            },
        );
        let inactive = runtime.snapshot();
        assert_eq!(inactive.models[0].limiter, "inactive");
        assert_eq!(inactive.models[0].penalty_basis_points, 0);
        assert_eq!(inactive.models[0].input_limit, Some(200_000));
        assert_eq!(inactive.models[0].effective_input_budget, Some(200_000));
        assert_eq!(inactive.models[0].input_window_used, Some(0));

        let mut completing_activation = fixture_outcome("model".to_owned());
        completing_activation.throttle.active = true;
        completing_activation.throttle.input_limit = Some(200_000);
        completing_activation.throttle.input_window_budget = Some(180_000);
        completing_activation.throttle.input_window_used_before = 120_000;
        completing_activation.throttle.reserved_input_tokens = 20_000;
        runtime.record_outcome(&completing_activation);
        let remains_inactive = runtime.snapshot();
        assert_eq!(remains_inactive.models[0].limiter, "inactive");
        assert_eq!(remains_inactive.models[0].input_window_used, Some(0));

        let capacity = ThrottleModelSnapshot {
            model: "model".to_owned(),
            active: true,
            input_limit: Some(200_000),
            effective_input_budget: Some(180_000),
            input_window_used: Some(120_000),
            penalty_basis_points: 1_000,
            queue_depth: 3,
        };
        runtime.record_capacity_snapshots(std::slice::from_ref(&capacity));
        let mut live = runtime.snapshot();
        live.apply_capacity_snapshots(&[capacity]);
        assert_eq!(live.models[0].limiter, "enforced");
        assert_eq!(live.models[0].input_window_used, Some(120_000));
        assert_eq!(live.models[0].queue_depth, 3);

        tokio::time::timeout(Duration::from_secs(6), receiver.recv())
            .await
            .expect("sampler publishes within one interval")
            .expect("SSE payload channel remains open");
    }

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn tracked_listener_counts_tcp_connection_lifetimes() {
        use axum::serve::Listener;

        let runtime = MetricsRuntime::new(MetricsConfig {
            mode: MetricsMode::Collect,
            routes_visible: true,
        })
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut listener = runtime.track_listener(listener);
        let client = TcpStream::connect(address);
        let (server, _) = tokio::join!(listener.accept(), client);
        assert_eq!(runtime.snapshot().summary.connections, 1);
        drop(server);
        tokio::task::yield_now().await;
        assert_eq!(runtime.snapshot().summary.connections, 0);
    }

    #[cfg(feature = "metrics-ui")]
    #[test]
    fn embedded_dashboard_contains_the_approved_assets() {
        let index = dashboard_asset("index.html").expect("dashboard index is embedded");
        let index = std::str::from_utf8(&index.body).unwrap();
        assert!(index.contains("Model proxy metrics"));
        assert!(index.contains("<th>Fallbacks</th>"));
        assert!(index.contains("app.js"));
        let app = dashboard_asset("app.js").expect("dashboard script is embedded");
        assert!(std::str::from_utf8(&app.body)
            .unwrap()
            .contains("penaltyBasisPoints"));
        assert!(std::str::from_utf8(&app.body)
            .unwrap()
            .contains("inputWindowUsed"));
        assert!(!dashboard_asset("app.js").unwrap().immutable);
        assert!(dashboard_asset("app.2675ef49.css").unwrap().immutable);
        assert!(dashboard_asset("assets/status-live-8.svg").is_some());
        assert!(dashboard_asset("missing.js").is_none());
    }

    #[cfg(feature = "metrics")]
    fn fixture_outcome(model: String) -> RequestOutcome {
        use std::net::SocketAddr;

        use axum::http::StatusCode;

        use crate::throttle::ThrottleAcquisition;

        RequestOutcome {
            route: "/v1/model",
            requested_model: model.clone(),
            resolved_model: model,
            peer: "127.0.0.1:1".parse::<SocketAddr>().unwrap(),
            request_bytes: 10,
            response_bytes: 20,
            duration_ms: 100,
            client_wire: None,
            target: None,
            streaming: false,
            reasoning_setting: Some(ReasoningSetting::Effort(
                dbx_tools_model::ReasoningEffort::High,
            )),
            status: StatusCode::OK,
            usage: Default::default(),
            throttle: ThrottleAcquisition::test_fixture(),
            upstream_attempt: 1,
            fallback_step: 0,
            finished: true,
            failed: false,
        }
    }
}
