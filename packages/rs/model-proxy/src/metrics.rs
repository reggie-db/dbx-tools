//! Bounded process-local metrics for headless and desktop proxy runtimes.

use std::{
    fmt,
    net::SocketAddr,
    pin::Pin,
    str::FromStr,
    task::{Context, Poll},
};

#[cfg(feature = "metrics")]
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dbx_tools_service::ServiceStorage;
#[cfg(feature = "metrics")]
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
#[cfg(feature = "metrics")]
use tokio::sync::broadcast;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
};

use crate::{adaptive::AutoTransition, request_log::RequestOutcome};
#[cfg(feature = "metrics")]
use crate::{adaptive::AutoTransitionKind, request_log::ReasoningSetting};
#[cfg(any(feature = "desktop", test))]
use crate::{rate_limit::RateLimitModelSnapshot, throttle::ThrottleModelSnapshot};

#[cfg(any(feature = "metrics", test))]
const MODEL_SERIES_LIMIT: usize = 32;
#[cfg(feature = "metrics")]
const DETAILED_BUCKET_LIMIT: usize = 720;
#[cfg(feature = "metrics")]
const ROLLUP_BUCKET_LIMIT: usize = 1_440;
#[cfg(feature = "metrics")]
const RATE_LIMIT_EVENT_LIMIT: usize = 128;
#[cfg(any(feature = "metrics", test))]
const RETENTION_TARGET_BYTES: u64 = 16 * 1024 * 1024;

/// Requested metrics behavior before build capabilities are resolved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MetricsOption {
    Auto,
    On,
    Off,
}

impl fmt::Display for MetricsOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Auto => "auto",
            Self::On => "on",
            Self::Off => "off",
        })
    }
}

impl FromStr for MetricsOption {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "off" | "false" => Ok(Self::Off),
            "on" | "true" => Ok(Self::On),
            _ => Err("expected auto, on, off, true, or false".to_owned()),
        }
    }
}

/// Resolved metrics behavior supported by the current binary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub(crate) enum MetricsMode {
    On,
    Off,
}

impl fmt::Display for MetricsMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::On => "on",
            Self::Off => "off",
        })
    }
}

pub(crate) const fn default_metrics_option() -> MetricsOption {
    MetricsOption::Auto
}

/// Validated metrics configuration for the running listener.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct MetricsConfig {
    pub(crate) mode: MetricsMode,
}

impl MetricsConfig {
    pub(crate) fn resolve(
        requested: MetricsOption,
        in_databricks_app: bool,
    ) -> Result<Self, MetricsError> {
        let mode = match requested {
            MetricsOption::Auto if in_databricks_app => MetricsMode::Off,
            MetricsOption::Auto if cfg!(feature = "metrics") => MetricsMode::On,
            MetricsOption::Auto => MetricsMode::Off,
            MetricsOption::Off => MetricsMode::Off,
            MetricsOption::On if cfg!(feature = "metrics") => MetricsMode::On,
            MetricsOption::On => return Err(MetricsError::CollectionUnavailable),
        };
        Ok(Self { mode })
    }
}

/// Persistent aggregate metrics scoped to one hashed runtime identity.
#[derive(Clone)]
#[cfg_attr(not(feature = "metrics"), allow(dead_code))]
pub(crate) struct MetricsPersistenceConfig {
    pub(crate) storage: ServiceStorage,
    pub(crate) runtime_key: String,
    pub(crate) max_bytes: u64,
}

#[derive(thiserror::Error)]
pub(crate) enum MetricsError {
    #[error("metrics collection is not compiled into this binary; use --metrics=false")]
    CollectionUnavailable,
    #[cfg(feature = "metrics")]
    #[error("aggregate metrics persistence failed: {0}")]
    Persistence(String),
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
    #[cfg(test)]
    pub(crate) fn new(config: MetricsConfig) -> Result<Self, MetricsError> {
        Self::new_with_persistence(config, None)
    }

    pub(crate) fn new_with_persistence(
        config: MetricsConfig,
        persistence: Option<MetricsPersistenceConfig>,
    ) -> Result<Self, MetricsError> {
        #[cfg(feature = "metrics")]
        let inner = if config.mode == MetricsMode::Off {
            None
        } else {
            Some(MetricsInner::new(persistence)?)
        };
        #[cfg(not(feature = "metrics"))]
        let _ = persistence;
        let runtime = Self {
            config,
            #[cfg(feature = "metrics")]
            inner,
        };
        #[cfg(feature = "metrics")]
        runtime.start_sampler();
        Ok(runtime)
    }

    pub(crate) fn activate_runtime(&self, runtime_key: String) -> Result<(), MetricsError> {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.activate_runtime(runtime_key)?;
        }
        #[cfg(not(feature = "metrics"))]
        let _ = runtime_key;
        Ok(())
    }

    pub(crate) fn mode(&self) -> MetricsMode {
        self.config.mode
    }

    pub(crate) fn collection_enabled(&self) -> bool {
        self.config.mode != MetricsMode::Off
    }

    pub(crate) async fn flush(&self) -> Result<(), MetricsError> {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let inner = Arc::clone(inner);
            return tokio::task::spawn_blocking(move || inner.persist())
                .await
                .map_err(|error| MetricsError::Persistence(error.to_string()))?;
        }
        Ok(())
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

    #[cfg(any(feature = "desktop", test))]
    pub(crate) fn snapshot(&self) -> MetricsSnapshot {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            let mut snapshot = inner.snapshot();
            snapshot.mode = self.config.mode;
            return snapshot;
        }
        MetricsSnapshot::disabled(self.config.mode)
    }

    #[cfg(any(feature = "desktop", test))]
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

    #[cfg(any(feature = "desktop", test))]
    pub(crate) fn record_capacity_snapshots(&self, capacities: &[ThrottleModelSnapshot]) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_capacity_snapshots(capacities);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = capacities;
    }

    #[cfg(any(feature = "desktop", test))]
    pub(crate) fn record_rate_limit_snapshots(
        &self,
        snapshots: &[RateLimitModelSnapshot],
        controls_enabled: bool,
    ) {
        #[cfg(feature = "metrics")]
        if let Some(inner) = &self.inner {
            inner.record_rate_limit_snapshots(snapshots, controls_enabled);
        }
        #[cfg(not(feature = "metrics"))]
        let _ = (snapshots, controls_enabled);
    }

    #[cfg(all(feature = "metrics", any(feature = "desktop", test)))]
    pub(crate) fn subscribe(&self) -> Option<broadcast::Receiver<()>> {
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
                let _ = inner.events.send(());
                let persistence = Arc::clone(&inner);
                match tokio::task::spawn_blocking(move || persistence.persist()).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "aggregate metrics persistence failed");
                    }
                    Err(error) => {
                        tracing::warn!(%error, "aggregate metrics persistence task failed");
                    }
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
#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSnapshot {
    pub(crate) mode: MetricsMode,
    pub(crate) controls_enabled: bool,
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
    #[cfg(any(feature = "desktop", test))]
    fn disabled(mode: MetricsMode) -> Self {
        Self {
            mode,
            controls_enabled: false,
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

    #[cfg(any(feature = "desktop", test))]
    pub(crate) fn apply_capacity_snapshots(&mut self, capacities: &[ThrottleModelSnapshot]) {
        for model in &mut self.models {
            model.reset_capacity();
        }
        for capacity in capacities {
            let (index, aggregate) = self.model_merge_index(&capacity.model);
            self.models[index].merge_capacity(capacity, aggregate);
        }
        self.finish_model_merge();
    }

    #[cfg(any(feature = "desktop", test))]
    pub(crate) fn apply_rate_limit_snapshots(
        &mut self,
        snapshots: &[RateLimitModelSnapshot],
        controls_enabled: bool,
    ) {
        self.controls_enabled = controls_enabled;
        for model in &mut self.models {
            model.reset_rate_limit();
        }
        for snapshot in snapshots {
            let (index, aggregate) = self.model_merge_index(&snapshot.model);
            self.models[index].merge_rate_limit(snapshot, aggregate);
        }
        self.finish_model_merge();
    }

    #[cfg(any(feature = "desktop", test))]
    fn model_merge_index(&mut self, model: &str) -> (usize, bool) {
        if let Some(index) = self
            .models
            .iter()
            .position(|current| current.model == model)
        {
            return (index, model == "other");
        }
        let named_models = self
            .models
            .iter()
            .filter(|current| current.model != "other")
            .count();
        let target = if model != "other" && named_models < MODEL_SERIES_LIMIT {
            model
        } else {
            "other"
        };
        if let Some(index) = self
            .models
            .iter()
            .position(|current| current.model == target)
        {
            return (index, target == "other");
        }
        self.models.push(ModelSnapshot::empty(target));
        (self.models.len() - 1, target == "other")
    }

    #[cfg(any(feature = "desktop", test))]
    fn finish_model_merge(&mut self) {
        self.models.sort_by(|left, right| {
            (left.model == "other")
                .cmp(&(right.model == "other"))
                .then_with(|| right.requests.cmp(&left.requests))
                .then_with(|| left.model.cmp(&right.model))
        });
        self.summary.active_models = self.models.len();
        self.summary.cooldown_keys = self.models.iter().map(|model| model.cooldown_keys).sum();
        self.summary.rate_limit_waiters = self
            .models
            .iter()
            .map(|model| {
                model
                    .capacity_waiters
                    .saturating_add(model.cooldown_waiters)
            })
            .sum();
        self.summary.probe_keys = self.models.iter().map(|model| model.probe_keys).sum();
        self.summary.wait_cancellations = self
            .models
            .iter()
            .map(|model| {
                model
                    .capacity_wait_cancellations
                    .saturating_add(model.cooldown_wait_cancellations)
            })
            .sum();
        self.summary.cooldown_releases = self
            .models
            .iter()
            .map(|model| model.cooldown_releases)
            .sum();
    }
}

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
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
    pub(crate) cooldown_keys: u64,
    pub(crate) rate_limit_waiters: u64,
    pub(crate) probe_keys: u64,
    pub(crate) wait_cancellations: u64,
    pub(crate) cooldown_releases: u64,
}

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
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

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReasoningLevelSnapshot {
    pub(crate) level: String,
    pub(crate) requests: u64,
}

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
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
    pub(crate) capacity_waiters: u64,
    pub(crate) cooldown_keys: u64,
    pub(crate) cooldown_waiters: u64,
    pub(crate) max_remaining_cooldown_ms: u64,
    pub(crate) probe_keys: u64,
    pub(crate) capacity_wait_cancellations: u64,
    pub(crate) cooldown_wait_cancellations: u64,
    pub(crate) cooldown_releases: u64,
    pub(crate) reasoning_levels: Vec<ReasoningLevelSnapshot>,
}

#[cfg(any(feature = "desktop", test))]
impl ModelSnapshot {
    fn empty(model: &str) -> Self {
        Self {
            model: model.to_owned(),
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
            queue_depth: 0,
            queue_depth_max: 0,
            p50_latency_ms: 0,
            p95_latency_ms: 0,
            p99_latency_ms: 0,
            limiter: "inactive".to_owned(),
            penalty_basis_points: 0,
            input_limit: None,
            effective_input_budget: None,
            input_window_used: None,
            capacity_waiters: 0,
            cooldown_keys: 0,
            cooldown_waiters: 0,
            max_remaining_cooldown_ms: 0,
            probe_keys: 0,
            capacity_wait_cancellations: 0,
            cooldown_wait_cancellations: 0,
            cooldown_releases: 0,
            reasoning_levels: Vec::new(),
        }
    }

    fn merge_capacity(&mut self, capacity: &ThrottleModelSnapshot, aggregate: bool) {
        self.queue_depth = if aggregate {
            self.queue_depth.saturating_add(capacity.queue_depth)
        } else {
            capacity.queue_depth
        };
        self.capacity_waiters = if aggregate {
            self.capacity_waiters.saturating_add(capacity.waiters)
        } else {
            capacity.waiters
        };
        self.capacity_wait_cancellations = if aggregate {
            self.capacity_wait_cancellations
                .saturating_add(capacity.wait_cancellations)
        } else {
            capacity.wait_cancellations
        };
        self.queue_depth_max = self.queue_depth_max.max(capacity.queue_depth);
        if capacity.active {
            self.limiter = "enforced".to_owned();
        } else if !aggregate {
            self.limiter = "inactive".to_owned();
        }
        if aggregate {
            self.penalty_basis_points =
                self.penalty_basis_points.max(capacity.penalty_basis_points);
            self.input_limit = None;
            self.effective_input_budget = None;
            self.input_window_used = None;
        } else {
            self.penalty_basis_points = capacity.penalty_basis_points;
            self.input_limit = capacity.input_limit;
            self.effective_input_budget = capacity.effective_input_budget;
            self.input_window_used = capacity.input_window_used;
        }
    }

    #[cfg(any(feature = "desktop", test))]
    fn reset_capacity(&mut self) {
        self.queue_depth = 0;
        self.capacity_waiters = 0;
        self.capacity_wait_cancellations = 0;
        self.limiter = "inactive".to_owned();
        self.penalty_basis_points = 0;
        self.input_limit = None;
        self.effective_input_budget = None;
        self.input_window_used = None;
    }

    fn merge_rate_limit(&mut self, snapshot: &RateLimitModelSnapshot, aggregate: bool) {
        if aggregate {
            self.cooldown_keys = self.cooldown_keys.saturating_add(snapshot.cooldown_keys);
            self.cooldown_waiters = self.cooldown_waiters.saturating_add(snapshot.waiters);
            self.probe_keys = self.probe_keys.saturating_add(snapshot.probe_keys);
            self.cooldown_wait_cancellations = self
                .cooldown_wait_cancellations
                .saturating_add(snapshot.wait_cancellations);
            self.cooldown_releases = self
                .cooldown_releases
                .saturating_add(snapshot.cooldown_releases);
        } else {
            self.cooldown_keys = snapshot.cooldown_keys;
            self.cooldown_waiters = snapshot.waiters;
            self.probe_keys = snapshot.probe_keys;
            self.cooldown_wait_cancellations = snapshot.wait_cancellations;
            self.cooldown_releases = snapshot.cooldown_releases;
        }
        self.max_remaining_cooldown_ms = self
            .max_remaining_cooldown_ms
            .max(snapshot.max_remaining_cooldown_ms);
    }

    fn reset_rate_limit(&mut self) {
        self.cooldown_keys = 0;
        self.cooldown_waiters = 0;
        self.max_remaining_cooldown_ms = 0;
        self.probe_keys = 0;
        self.cooldown_wait_cancellations = 0;
        self.cooldown_releases = 0;
    }
}

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitEvent {
    pub(crate) at_ms: u64,
    pub(crate) model: String,
    pub(crate) transition: AutoTransition,
}

#[cfg(any(feature = "metrics", test))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
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
    timeline_base_ms: AtomicU64,
    store: Mutex<MetricsStore>,
    connections: AtomicU64,
    active_requests: AtomicU64,
    active_streams: AtomicU64,
    events: broadcast::Sender<()>,
    active_runtime_key: Mutex<Option<String>>,
    persistence: Mutex<Option<MetricsPersistenceState>>,
}

#[cfg(feature = "metrics")]
#[derive(Clone)]
struct MetricsPersistenceState {
    storage: ServiceStorage,
    runtime_key: String,
    max_bytes: u64,
}

#[cfg(feature = "metrics")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMetrics {
    version: u8,
    stored_at_ms: u64,
    snapshot: MetricsSnapshot,
}

#[cfg(feature = "metrics")]
impl MetricsInner {
    fn new(persistence: Option<MetricsPersistenceConfig>) -> Result<Arc<Self>, MetricsError> {
        let (events, _) = broadcast::channel(8);
        let mut timeline_base_ms = 0;
        let mut store = MetricsStore::new();
        let persistence = persistence.map(|config| MetricsPersistenceState {
            storage: config.storage,
            runtime_key: config.runtime_key,
            max_bytes: config.max_bytes,
        });
        let active_runtime_key = persistence
            .as_ref()
            .map(|persistence| persistence.runtime_key.clone());
        if let Some(persistence) = &persistence {
            if let Some(payload) = persistence
                .storage
                .load_aggregate_metrics(&persistence.runtime_key)
                .map_err(|error| MetricsError::Persistence(error.to_string()))?
            {
                match serde_json::from_slice::<PersistedMetrics>(&payload) {
                    Ok(restored) if restored.version == 1 => {
                        let now = wall_clock_ms();
                        timeline_base_ms = restored
                            .snapshot
                            .generated_at_ms
                            .saturating_add(now.saturating_sub(restored.stored_at_ms));
                        store = MetricsStore::restore(restored.snapshot, timeline_base_ms);
                    }
                    Ok(_) => tracing::warn!("aggregate metrics version is unsupported"),
                    Err(error) => {
                        tracing::warn!(%error, "aggregate metrics snapshot could not be restored")
                    }
                }
            }
        }
        Ok(Arc::new(Self {
            started: tokio::time::Instant::now(),
            timeline_base_ms: AtomicU64::new(timeline_base_ms),
            store: Mutex::new(store),
            connections: AtomicU64::new(0),
            active_requests: AtomicU64::new(0),
            active_streams: AtomicU64::new(0),
            events,
            active_runtime_key: Mutex::new(active_runtime_key),
            persistence: Mutex::new(persistence),
        }))
    }

    fn timeline_ms(&self) -> u64 {
        self.timeline_base_ms
            .load(Ordering::Relaxed)
            .saturating_add(self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
    }

    fn persist(&self) -> Result<(), MetricsError> {
        let persistence = self
            .persistence
            .lock()
            .expect("metrics persistence lock is not poisoned")
            .clone();
        let Some(persistence) = persistence else {
            return Ok(());
        };
        let timeline_ms = self.timeline_ms();
        let snapshot = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .snapshot_for_persistence(timeline_ms);
        let stored_at_ms = wall_clock_ms();
        let payload = serde_json::to_vec(&PersistedMetrics {
            version: 1,
            stored_at_ms,
            snapshot,
        })
        .map_err(|error| MetricsError::Persistence(error.to_string()))?;
        persistence
            .storage
            .store_aggregate_metrics(
                &persistence.runtime_key,
                &payload,
                stored_at_ms,
                persistence.max_bytes,
            )
            .map_err(|error| MetricsError::Persistence(error.to_string()))?;
        Ok(())
    }

    fn activate_runtime(&self, runtime_key: String) -> Result<(), MetricsError> {
        self.persist()?;
        *self
            .active_runtime_key
            .lock()
            .expect("active runtime key lock is not poisoned") = Some(runtime_key.clone());
        let mut persistence = self
            .persistence
            .lock()
            .expect("metrics persistence lock is not poisoned");
        let Some(state) = persistence.as_mut() else {
            *self
                .store
                .lock()
                .expect("metrics store lock is not poisoned") = MetricsStore::new();
            self.timeline_base_ms.store(0, Ordering::Relaxed);
            return Ok(());
        };
        state.runtime_key = runtime_key;
        let restored = state
            .storage
            .load_aggregate_metrics(&state.runtime_key)
            .map_err(|error| MetricsError::Persistence(error.to_string()))?
            .and_then(
                |payload| match serde_json::from_slice::<PersistedMetrics>(&payload) {
                    Ok(restored) => Some(restored),
                    Err(error) => {
                        tracing::warn!(%error, "aggregate metrics snapshot could not be restored");
                        None
                    }
                },
            );
        let (store, timeline_base_ms) =
            if let Some(restored) = restored.filter(|restored| restored.version == 1) {
                let timeline = restored
                    .snapshot
                    .generated_at_ms
                    .saturating_add(wall_clock_ms().saturating_sub(restored.stored_at_ms));
                (MetricsStore::restore(restored.snapshot, timeline), timeline)
            } else {
                (MetricsStore::new(), 0)
            };
        *self
            .store
            .lock()
            .expect("metrics store lock is not poisoned") = store;
        self.timeline_base_ms
            .store(timeline_base_ms, Ordering::Relaxed);
        Ok(())
    }

    fn record_outcome(&self, outcome: &RequestOutcome) {
        let elapsed_ms = self.timeline_ms();
        let active = self
            .active_runtime_key
            .lock()
            .expect("active runtime key lock is not poisoned")
            .as_deref()
            == Some(outcome.runtime_key.as_str());
        let model_label = if active {
            self.store
                .lock()
                .expect("metrics store lock is not poisoned")
                .record_outcome(elapsed_ms, outcome)
        } else {
            "other".to_owned()
        };
        let status_class = format!("{}xx", outcome.status.as_u16() / 100);
        let streaming = if outcome.streaming { "true" } else { "false" };
        let client = outcome
            .client_wire
            .map(|wire| wire.label().to_owned())
            .unwrap_or_else(|| "embedding".to_owned());
        let target = outcome
            .target
            .map(|wire| wire.label().to_owned())
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
        let elapsed_ms = self.timeline_ms();
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
        let elapsed_ms = self.timeline_ms();
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
        let elapsed_ms = self.timeline_ms();
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
        let elapsed_ms = self.timeline_ms();
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
        let elapsed_ms = self.timeline_ms();
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

    #[cfg(any(feature = "desktop", test))]
    fn record_capacity_snapshots(&self, capacities: &[ThrottleModelSnapshot]) {
        let labels = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_capacity_snapshots(capacities);
        for (capacity, model) in capacities.iter().zip(labels) {
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
                    "model" => model.clone()
                )
                .set(input_used as f64);
            }
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_capacity_waiters",
                "model" => model.clone()
            )
            .set(capacity.waiters as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_capacity_wait_cancellations",
                "model" => model
            )
            .set(capacity.wait_cancellations as f64);
        }
    }

    #[cfg(any(feature = "desktop", test))]
    fn record_rate_limit_snapshots(
        &self,
        snapshots: &[RateLimitModelSnapshot],
        controls_enabled: bool,
    ) {
        let labels = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .record_rate_limit_snapshots(snapshots, controls_enabled);
        for (snapshot, model) in snapshots.iter().zip(labels) {
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_cooldown_keys",
                "model" => model.clone()
            )
            .set(snapshot.cooldown_keys as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_cooldown_waiters",
                "model" => model.clone()
            )
            .set(snapshot.waiters as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_max_remaining_cooldown_seconds",
                "model" => model.clone()
            )
            .set(snapshot.max_remaining_cooldown_ms as f64 / 1_000.0);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_probe_keys",
                "model" => model.clone()
            )
            .set(snapshot.probe_keys as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_cooldown_wait_cancellations",
                "model" => model.clone()
            )
            .set(snapshot.wait_cancellations as f64);
            ::metrics::gauge!(
                "dbx_model_proxy_rate_limit_cooldown_releases",
                "model" => model
            )
            .set(snapshot.cooldown_releases as f64);
        }
    }

    #[cfg(any(feature = "desktop", test))]
    fn snapshot(&self) -> MetricsSnapshot {
        self.snapshot_with_model(None)
    }

    #[cfg(any(feature = "desktop", test))]
    fn snapshot_for_model(&self, model: &str) -> MetricsSnapshot {
        self.snapshot_with_model(Some(model))
    }

    #[cfg(any(feature = "desktop", test))]
    fn snapshot_with_model(&self, model: Option<&str>) -> MetricsSnapshot {
        let elapsed_ms = self.timeline_ms();
        let connections = self.connections.load(Ordering::Relaxed);
        let active_requests = self.active_requests.load(Ordering::Relaxed);
        let active_streams = self.active_streams.load(Ordering::Relaxed);
        let mut snapshot = self
            .store
            .lock()
            .expect("metrics store lock is not poisoned")
            .snapshot(
                elapsed_ms,
                connections,
                active_requests,
                active_streams,
                model,
            );
        snapshot.uptime_seconds = self.started.elapsed().as_secs();
        snapshot.retention.process_local = self
            .persistence
            .lock()
            .expect("metrics persistence lock is not poisoned")
            .is_none();
        snapshot
    }
}

#[cfg(feature = "metrics")]
fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
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

    fn restore(snapshots: &[ReasoningLevelSnapshot]) -> Self {
        let mut counts = Self::default();
        for snapshot in snapshots {
            if let Some(setting) = ReasoningSetting::ALL
                .into_iter()
                .find(|setting| setting.label() == snapshot.level)
            {
                counts.requests[setting.index()] = snapshot.requests;
            }
        }
        counts
    }
}

#[cfg(feature = "metrics")]
#[derive(Debug)]
struct MetricsStore {
    controls_enabled: bool,
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
            controls_enabled: false,
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

    fn restore(snapshot: MetricsSnapshot, timeline_ms: u64) -> Self {
        let (detailed, detailed_current) =
            restore_buckets(snapshot.history, timeline_ms, 5_000, DETAILED_BUCKET_LIMIT);
        let (rollups, rollup_current) = restore_buckets(
            snapshot.rollup_history,
            timeline_ms,
            60_000,
            ROLLUP_BUCKET_LIMIT,
        );
        let mut latency = latency_histogram();
        restore_quantiles(
            &mut latency,
            snapshot.summary.p50_latency_ms,
            snapshot.summary.p95_latency_ms,
            snapshot.summary.p99_latency_ms,
        );
        let mut models = HashMap::with_capacity(MODEL_SERIES_LIMIT);
        let mut other = ModelMetrics::new("other");
        for model in snapshot.models {
            let restored = ModelMetrics::restore(model, timeline_ms);
            if restored.model == "other" {
                other = restored;
            } else if models.len() < MODEL_SERIES_LIMIT {
                models.insert(restored.model.clone(), restored);
            }
        }
        let mut rate_limit_events = snapshot
            .rate_limit_events
            .into_iter()
            .filter(|event| event.at_ms.saturating_add(86_400_000) >= timeline_ms)
            .collect::<VecDeque<_>>();
        while rate_limit_events.len() > RATE_LIMIT_EVENT_LIMIT {
            rate_limit_events.pop_front();
        }
        Self {
            controls_enabled: false,
            total_requests: snapshot.summary.total_requests,
            total_rate_limited: snapshot.summary.total_rate_limited,
            total_fallbacks: snapshot.summary.total_fallbacks,
            latency,
            detailed,
            detailed_current,
            rollups,
            rollup_current,
            models,
            other,
            reasoning: ReasoningCounts::restore(&snapshot.reasoning_levels),
            rate_limit_events,
        }
    }

    fn snapshot_for_persistence(&mut self, elapsed_ms: u64) -> MetricsSnapshot {
        let mut snapshot = self.snapshot(elapsed_ms, 0, 0, 0, None);
        let mut models = self
            .models
            .values_mut()
            .map(|model| model.snapshot(elapsed_ms, true))
            .collect::<Vec<_>>();
        if self.other.requests > 0
            || self.other.rate_limited > 0
            || self.other.oversized_rejections > 0
        {
            models.push(self.other.snapshot(elapsed_ms, true));
        }
        models.sort_by(|left, right| left.model.cmp(&right.model));
        snapshot.models = models;
        snapshot
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

    #[cfg(any(feature = "desktop", test))]
    fn record_capacity_snapshots(&mut self, capacities: &[ThrottleModelSnapshot]) -> Vec<String> {
        for model in self.models.values_mut() {
            model.reset_capacity();
        }
        self.other.reset_capacity();
        capacities
            .iter()
            .map(|capacity| {
                let label = self.model_label(&capacity.model);
                if label == "other" {
                    self.other.merge_capacity(capacity, true);
                } else {
                    self.models
                        .entry(label.clone())
                        .or_insert_with(|| ModelMetrics::new(&label))
                        .merge_capacity(capacity, false);
                }
                label
            })
            .collect()
    }

    #[cfg(any(feature = "desktop", test))]
    fn record_rate_limit_snapshots(
        &mut self,
        snapshots: &[RateLimitModelSnapshot],
        controls_enabled: bool,
    ) -> Vec<String> {
        self.controls_enabled = controls_enabled;
        for model in self.models.values_mut() {
            model.reset_rate_limit();
        }
        self.other.reset_rate_limit();
        snapshots
            .iter()
            .map(|snapshot| {
                let label = self.model_label(&snapshot.model);
                if label == "other" {
                    self.other.merge_rate_limit(snapshot, true);
                } else {
                    self.models
                        .entry(label.clone())
                        .or_insert_with(|| ModelMetrics::new(&label))
                        .merge_rate_limit(snapshot, false);
                }
                label
            })
            .collect()
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
            || self.other.capacity_waiters > 0
            || self.other.cooldown_keys > 0
            || self.other.capacity_wait_cancellations > 0
            || self.other.cooldown_wait_cancellations > 0
            || self.other.cooldown_releases > 0
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
            mode: MetricsMode::On,
            controls_enabled: self.controls_enabled,
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
                cooldown_keys: models.iter().map(|model| model.cooldown_keys).sum(),
                rate_limit_waiters: models
                    .iter()
                    .map(|model| {
                        model
                            .capacity_waiters
                            .saturating_add(model.cooldown_waiters)
                    })
                    .sum(),
                probe_keys: models.iter().map(|model| model.probe_keys).sum(),
                wait_cancellations: models
                    .iter()
                    .map(|model| {
                        model
                            .capacity_wait_cancellations
                            .saturating_add(model.cooldown_wait_cancellations)
                    })
                    .sum(),
                cooldown_releases: models.iter().map(|model| model.cooldown_releases).sum(),
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

    fn restore(snapshot: BucketSnapshot) -> Self {
        Self {
            started_at_ms: snapshot.started_at_ms,
            requests: snapshot.requests,
            input_tokens: snapshot.input_tokens,
            output_tokens: snapshot.output_tokens,
            errors: snapshot.errors,
            rate_limited: snapshot.rate_limited,
            latency_total_ms: snapshot
                .average_latency_ms
                .saturating_mul(snapshot.requests),
            latency_maximum_ms: snapshot.maximum_latency_ms,
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
    capacity_waiters: u64,
    cooldown_keys: u64,
    cooldown_waiters: u64,
    max_remaining_cooldown_ms: u64,
    probe_keys: u64,
    capacity_wait_cancellations: u64,
    cooldown_wait_cancellations: u64,
    cooldown_releases: u64,
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
            capacity_waiters: 0,
            cooldown_keys: 0,
            cooldown_waiters: 0,
            max_remaining_cooldown_ms: 0,
            probe_keys: 0,
            capacity_wait_cancellations: 0,
            cooldown_wait_cancellations: 0,
            cooldown_releases: 0,
            reasoning: ReasoningCounts::default(),
        }
    }

    fn restore(snapshot: ModelSnapshot, timeline_ms: u64) -> Self {
        let (detailed, detailed_current) =
            restore_buckets(snapshot.history, timeline_ms, 5_000, DETAILED_BUCKET_LIMIT);
        let (rollups, rollup_current) = restore_buckets(
            snapshot.rollup_history,
            timeline_ms,
            60_000,
            ROLLUP_BUCKET_LIMIT,
        );
        let mut latency = latency_histogram();
        restore_quantiles(
            &mut latency,
            snapshot.p50_latency_ms,
            snapshot.p95_latency_ms,
            snapshot.p99_latency_ms,
        );
        Self {
            model: snapshot.model,
            detailed,
            detailed_current,
            rollups,
            rollup_current,
            requests: snapshot.requests,
            input_tokens: snapshot.input_tokens,
            output_tokens: snapshot.output_tokens,
            errors: snapshot.errors,
            rate_limited: snapshot.rate_limited,
            oversized_rejections: snapshot.oversized_rejections,
            retries: snapshot.retries,
            fallbacks: snapshot.fallbacks,
            queue_wait_ms: snapshot.queue_wait_ms,
            queue_depth: 0,
            queue_depth_max: snapshot.queue_depth_max,
            latency,
            limiter: "inactive".to_owned(),
            limiter_observed: false,
            penalty_basis_points: 0,
            input_limit: None,
            effective_input_budget: None,
            input_window_used: None,
            capacity_waiters: 0,
            cooldown_keys: 0,
            cooldown_waiters: 0,
            max_remaining_cooldown_ms: 0,
            probe_keys: 0,
            capacity_wait_cancellations: snapshot.capacity_wait_cancellations,
            cooldown_wait_cancellations: snapshot.cooldown_wait_cancellations,
            cooldown_releases: snapshot.cooldown_releases,
            reasoning: ReasoningCounts::restore(&snapshot.reasoning_levels),
        }
    }

    #[cfg(any(feature = "desktop", test))]
    fn reset_capacity(&mut self) {
        self.queue_depth = 0;
        self.capacity_waiters = 0;
        self.limiter = "inactive".to_owned();
        self.penalty_basis_points = 0;
        self.input_limit = None;
        self.effective_input_budget = None;
        self.input_window_used = None;
        self.capacity_wait_cancellations = 0;
    }

    #[cfg(any(feature = "desktop", test))]
    fn merge_capacity(&mut self, capacity: &ThrottleModelSnapshot, aggregate: bool) {
        self.queue_depth = self.queue_depth.saturating_add(capacity.queue_depth);
        self.queue_depth_max = self.queue_depth_max.max(capacity.queue_depth);
        self.capacity_waiters = self.capacity_waiters.saturating_add(capacity.waiters);
        self.capacity_wait_cancellations = if aggregate {
            self.capacity_wait_cancellations
                .saturating_add(capacity.wait_cancellations)
        } else {
            capacity.wait_cancellations
        };
        if capacity.active {
            self.limiter = "enforced".to_owned();
        }
        self.penalty_basis_points = self.penalty_basis_points.max(capacity.penalty_basis_points);
        if !aggregate {
            self.input_limit = capacity.input_limit;
            self.effective_input_budget = capacity.effective_input_budget;
            self.input_window_used = capacity.input_window_used;
        }
    }

    #[cfg(any(feature = "desktop", test))]
    fn reset_rate_limit(&mut self) {
        self.cooldown_keys = 0;
        self.cooldown_waiters = 0;
        self.max_remaining_cooldown_ms = 0;
        self.probe_keys = 0;
        self.cooldown_wait_cancellations = 0;
        self.cooldown_releases = 0;
    }

    #[cfg(any(feature = "desktop", test))]
    fn merge_rate_limit(&mut self, snapshot: &RateLimitModelSnapshot, aggregate: bool) {
        self.cooldown_keys = self.cooldown_keys.saturating_add(snapshot.cooldown_keys);
        self.cooldown_waiters = self.cooldown_waiters.saturating_add(snapshot.waiters);
        self.max_remaining_cooldown_ms = self
            .max_remaining_cooldown_ms
            .max(snapshot.max_remaining_cooldown_ms);
        self.probe_keys = self.probe_keys.saturating_add(snapshot.probe_keys);
        self.cooldown_wait_cancellations = if aggregate {
            self.cooldown_wait_cancellations
                .saturating_add(snapshot.wait_cancellations)
        } else {
            snapshot.wait_cancellations
        };
        self.cooldown_releases = if aggregate {
            self.cooldown_releases
                .saturating_add(snapshot.cooldown_releases)
        } else {
            snapshot.cooldown_releases
        };
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
            capacity_waiters: self.capacity_waiters,
            cooldown_keys: self.cooldown_keys,
            cooldown_waiters: self.cooldown_waiters,
            max_remaining_cooldown_ms: self.max_remaining_cooldown_ms,
            probe_keys: self.probe_keys,
            capacity_wait_cancellations: self.capacity_wait_cancellations,
            cooldown_wait_cancellations: self.cooldown_wait_cancellations,
            cooldown_releases: self.cooldown_releases,
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
fn restore_quantiles(histogram: &mut Histogram<u64>, p50: u64, p95: u64, p99: u64) {
    for value in [p50, p95, p99].into_iter().filter(|value| *value > 0) {
        let _ = histogram.record(value);
    }
}

#[cfg(feature = "metrics")]
fn restore_buckets(
    snapshots: Vec<BucketSnapshot>,
    elapsed_ms: u64,
    resolution_ms: u64,
    limit: usize,
) -> (VecDeque<Bucket>, Bucket) {
    let current_start = elapsed_ms / resolution_ms * resolution_ms;
    let retained_after = current_start.saturating_sub(resolution_ms.saturating_mul(limit as u64));
    let mut buckets = snapshots
        .into_iter()
        .filter(|bucket| bucket.started_at_ms >= retained_after)
        .map(Bucket::restore)
        .collect::<Vec<_>>();
    buckets.sort_by_key(|bucket| bucket.started_at_ms);
    buckets.dedup_by_key(|bucket| bucket.started_at_ms);
    let current = if buckets
        .last()
        .is_some_and(|bucket| bucket.started_at_ms == current_start)
    {
        buckets.pop().expect("current bucket exists")
    } else {
        Bucket {
            started_at_ms: current_start,
            ..Bucket::default()
        }
    };
    while buckets.len() > limit {
        buckets.remove(0);
    }
    (buckets.into(), current)
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
    let retained_after = start.saturating_sub(resolution_ms.saturating_mul(limit as u64));
    while history
        .front()
        .is_some_and(|bucket| bucket.started_at_ms < retained_after)
    {
        history.pop_front();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_aliases_and_build_defaults_are_stable() {
        assert_eq!("true".parse::<MetricsOption>().unwrap(), MetricsOption::On);
        assert_eq!(
            "false".parse::<MetricsOption>().unwrap(),
            MetricsOption::Off
        );
        assert_eq!("on".parse::<MetricsOption>().unwrap(), MetricsOption::On);
        assert_eq!(default_metrics_option(), MetricsOption::Auto);
        assert_eq!(
            "auto".parse::<MetricsOption>().unwrap(),
            MetricsOption::Auto
        );
    }

    #[test]
    fn automatic_metrics_disable_in_databricks_apps() {
        assert_eq!(
            MetricsConfig::resolve(MetricsOption::Auto, true)
                .unwrap()
                .mode,
            MetricsMode::Off
        );
    }

    #[cfg(not(feature = "metrics"))]
    #[test]
    fn metrics_free_build_rejects_collection() {
        assert!(matches!(
            MetricsConfig::resolve(MetricsOption::On, false),
            Err(MetricsError::CollectionUnavailable)
        ));
        assert_eq!(
            MetricsConfig::resolve(MetricsOption::Off, false)
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
    async fn snapshots_and_desktop_ticks_share_one_recorded_outcome() {
        let runtime = MetricsRuntime::new(MetricsConfig {
            mode: MetricsMode::On,
        })
        .unwrap();
        runtime.activate_runtime("runtime".into()).unwrap();
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
            waiters: 3,
            wait_cancellations: 2,
        };
        runtime.record_capacity_snapshots(std::slice::from_ref(&capacity));
        let cooldown = RateLimitModelSnapshot {
            model: "model".to_owned(),
            cooldown_keys: 2,
            waiters: 4,
            max_remaining_cooldown_ms: 12_500,
            probe_keys: 1,
            wait_cancellations: 3,
            cooldown_releases: 1,
        };
        runtime.record_rate_limit_snapshots(std::slice::from_ref(&cooldown), true);
        let mut live = runtime.snapshot();
        live.apply_capacity_snapshots(&[capacity]);
        live.apply_rate_limit_snapshots(&[cooldown], true);
        assert_eq!(live.models[0].limiter, "enforced");
        assert_eq!(live.models[0].input_window_used, Some(120_000));
        assert_eq!(live.models[0].queue_depth, 3);
        assert_eq!(live.models[0].capacity_waiters, 3);
        assert_eq!(live.models[0].cooldown_keys, 2);
        assert_eq!(live.models[0].cooldown_waiters, 4);
        assert_eq!(live.models[0].max_remaining_cooldown_ms, 12_500);
        assert_eq!(live.models[0].probe_keys, 1);
        assert_eq!(live.summary.rate_limit_waiters, 7);
        assert_eq!(live.summary.wait_cancellations, 5);
        assert_eq!(live.summary.cooldown_releases, 1);
        assert!(live.controls_enabled);
        tokio::time::timeout(Duration::from_secs(6), receiver.recv())
            .await
            .expect("sampler publishes within one interval")
            .expect("desktop update channel remains open");
    }

    #[test]
    fn live_model_merges_preserve_the_named_model_bound() {
        let mut snapshot = MetricsSnapshot::disabled(MetricsMode::On);
        let capacities = (0..40)
            .map(|index| ThrottleModelSnapshot {
                model: format!("capacity-{index}"),
                active: true,
                queue_depth: 1,
                waiters: 1,
                ..ThrottleModelSnapshot::default()
            })
            .collect::<Vec<_>>();
        snapshot.apply_capacity_snapshots(&capacities);
        let cooldowns = (0..40)
            .map(|index| RateLimitModelSnapshot {
                model: format!("cooldown-{index}"),
                cooldown_keys: 1,
                waiters: 1,
                ..RateLimitModelSnapshot::default()
            })
            .collect::<Vec<_>>();
        snapshot.apply_rate_limit_snapshots(&cooldowns, true);

        assert_eq!(
            snapshot
                .models
                .iter()
                .filter(|model| model.model != "other")
                .count(),
            MODEL_SERIES_LIMIT
        );
        assert_eq!(
            snapshot
                .models
                .iter()
                .filter(|model| model.model == "other")
                .count(),
            1
        );
        assert!(snapshot.models.len() <= MODEL_SERIES_LIMIT + 1);
        assert!(snapshot.controls_enabled);
    }

    #[test]
    fn desktop_metric_numbers_fit_javascript_integer_precision() {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

        fn assert_safe(value: &serde_json::Value) {
            match value {
                serde_json::Value::Array(values) => values.iter().for_each(assert_safe),
                serde_json::Value::Object(values) => values.values().for_each(assert_safe),
                serde_json::Value::Number(number) => {
                    if let Some(value) = number.as_u64() {
                        assert!(value <= MAX_SAFE_INTEGER);
                    }
                }
                _ => {}
            }
        }

        let mut snapshot = MetricsSnapshot::disabled(MetricsMode::On);
        snapshot.summary.total_requests = MAX_SAFE_INTEGER;
        assert_safe(&serde_json::to_value(snapshot).unwrap());
    }

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn tracked_listener_counts_tcp_connection_lifetimes() {
        use axum::serve::Listener;

        let runtime = MetricsRuntime::new(MetricsConfig {
            mode: MetricsMode::On,
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

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn aggregate_metrics_restore_by_opaque_runtime_key() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ServiceStorage::open(directory.path()).unwrap();
        let config = MetricsConfig {
            mode: MetricsMode::On,
        };
        let runtime = MetricsRuntime::new_with_persistence(
            config,
            Some(MetricsPersistenceConfig {
                storage: storage.clone(),
                runtime_key: "runtime-a".into(),
                max_bytes: 1024 * 1024,
            }),
        )
        .unwrap();
        let mut outcome = fixture_outcome("model".into());
        outcome.runtime_key = "runtime-a".into();
        runtime.record_outcome(&outcome);
        runtime.inner.as_ref().unwrap().persist().unwrap();

        let restored = MetricsRuntime::new_with_persistence(
            config,
            Some(MetricsPersistenceConfig {
                storage,
                runtime_key: "runtime-a".into(),
                max_bytes: 1024 * 1024,
            }),
        )
        .unwrap();
        let snapshot = restored.snapshot_for_model("model");
        assert_eq!(snapshot.summary.total_requests, 1);
        assert_eq!(snapshot.models[0].model, "model");
        assert_eq!(snapshot.models[0].requests, 1);
        assert!(!snapshot.models[0].history.is_empty());
        assert!(!snapshot.retention.process_local);

        restored.activate_runtime("runtime-b".into()).unwrap();
        assert_eq!(restored.snapshot().summary.total_requests, 0);
        restored.activate_runtime("runtime-a".into()).unwrap();
        assert_eq!(restored.snapshot().summary.total_requests, 1);
    }

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn memory_runtime_switch_starts_fresh_aggregates() {
        let runtime = MetricsRuntime::new(MetricsConfig {
            mode: MetricsMode::On,
        })
        .unwrap();
        runtime.activate_runtime("runtime".into()).unwrap();
        runtime.record_outcome(&fixture_outcome("model".into()));
        assert_eq!(runtime.snapshot().summary.total_requests, 1);
        runtime.activate_runtime("another-runtime".into()).unwrap();
        assert_eq!(runtime.snapshot().summary.total_requests, 0);
        runtime.record_outcome(&fixture_outcome("model".into()));
        assert_eq!(runtime.snapshot().summary.total_requests, 0);
        let mut current = fixture_outcome("model".into());
        current.runtime_key = "another-runtime".into();
        runtime.record_outcome(&current);
        assert_eq!(runtime.snapshot().summary.total_requests, 1);
    }

    #[cfg(feature = "metrics")]
    fn fixture_outcome(model: String) -> RequestOutcome {
        use std::net::SocketAddr;

        use axum::http::StatusCode;

        use crate::throttle::ThrottleAcquisition;

        RequestOutcome {
            runtime_key: "runtime".to_owned(),
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
