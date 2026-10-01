//! Shared request-completion logging for buffered and streaming routes.

use std::{net::SocketAddr, time::Instant};

use axum::http::StatusCode;
use dbx_tools_model::ReasoningEffort;
use serde_json::Value;

use crate::{
    metrics::MetricsRuntime,
    protocol::{ClientWire, TargetWire},
    throttle::{ResponseTokenUsage, ThrottleAcquisition},
};

/// One completed request consumed by logging and process-local metrics.
#[derive(Debug)]
pub(crate) struct RequestOutcome {
    #[cfg_attr(not(feature = "metrics"), allow(dead_code))]
    pub(crate) runtime_key: String,
    pub(crate) route: &'static str,
    pub(crate) requested_model: String,
    pub(crate) resolved_model: String,
    pub(crate) peer: SocketAddr,
    pub(crate) request_bytes: usize,
    pub(crate) response_bytes: u64,
    pub(crate) duration_ms: u64,
    pub(crate) client_wire: Option<ClientWire>,
    pub(crate) target: Option<TargetWire>,
    pub(crate) streaming: bool,
    pub(crate) reasoning_setting: Option<ReasoningSetting>,
    pub(crate) status: StatusCode,
    pub(crate) usage: ResponseTokenUsage,
    pub(crate) throttle: ThrottleAcquisition,
    pub(crate) upstream_attempt: u32,
    pub(crate) fallback_step: usize,
    pub(crate) finished: bool,
    pub(crate) failed: bool,
}

/// Request metadata shared by buffered and streamed completion events.
#[derive(Debug)]
pub(crate) struct RequestLogContext {
    runtime_key: String,
    requested_model: String,
    resolved_model: String,
    peer: SocketAddr,
    request_bytes: usize,
    started: Instant,
    reasoning_setting: Option<ReasoningSetting>,
    throttle: ThrottleAcquisition,
    upstream_attempt: u32,
    fallback_step: usize,
    metrics: MetricsRuntime,
}

/// Request fields captured before upstream admission.
#[derive(Debug)]
pub(crate) struct RequestLogMetadata {
    pub(crate) runtime_key: String,
    pub(crate) requested_model: String,
    pub(crate) resolved_model: String,
    pub(crate) peer: SocketAddr,
    pub(crate) request_bytes: usize,
    pub(crate) started: Instant,
    pub(crate) reasoning_setting: Option<ReasoningSetting>,
    pub(crate) fallback_step: usize,
}

/// Bounded reasoning classification retained by logs and aggregate metrics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReasoningSetting {
    Default,
    Effort(ReasoningEffort),
    Adaptive,
    Enabled,
}

impl ReasoningSetting {
    #[cfg(feature = "metrics")]
    pub(crate) const COUNT: usize = 10;
    #[cfg(feature = "metrics")]
    pub(crate) const ALL: [Self; Self::COUNT] = [
        Self::Default,
        Self::Effort(ReasoningEffort::None),
        Self::Effort(ReasoningEffort::Minimal),
        Self::Effort(ReasoningEffort::Low),
        Self::Effort(ReasoningEffort::Medium),
        Self::Effort(ReasoningEffort::High),
        Self::Effort(ReasoningEffort::Xhigh),
        Self::Effort(ReasoningEffort::Max),
        Self::Adaptive,
        Self::Enabled,
    ];

    pub(crate) fn from_request(input: &Value) -> Self {
        let effort = [
            input.get("reasoning_effort"),
            input.pointer("/reasoning/effort"),
            input.pointer("/thinking/effort"),
            input.pointer("/thinking_config/thinking_level"),
            input.pointer("/thinkingConfig/thinkingLevel"),
        ]
        .into_iter()
        .flatten()
        .find_map(Value::as_str);
        if let Some(effort) = effort {
            return Self::from_wire(effort).unwrap_or(Self::Enabled);
        }

        let mode = [
            input.pointer("/thinking/type"),
            input.pointer("/reasoning/type"),
        ]
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::to_ascii_lowercase);
        match mode.as_deref() {
            Some("adaptive") => return Self::Adaptive,
            Some("disabled" | "none") => return Self::Effort(ReasoningEffort::None),
            Some("enabled") => return Self::Enabled,
            _ => {}
        }

        for pointer in [
            "/thinking_config/thinking_budget",
            "/thinkingConfig/thinkingBudget",
            "/thinking/budget_tokens",
        ] {
            if let Some(budget) = input.pointer(pointer).and_then(Value::as_i64) {
                return if budget <= 0 {
                    Self::Effort(ReasoningEffort::None)
                } else {
                    Self::Enabled
                };
            }
        }

        if input.pointer("/reasoning/enabled").and_then(Value::as_bool) == Some(false) {
            return Self::Effort(ReasoningEffort::None);
        }
        if input.get("reasoning").is_some_and(|value| !value.is_null())
            || input.get("thinking").is_some_and(|value| !value.is_null())
            || input
                .get("thinking_config")
                .or_else(|| input.get("thinkingConfig"))
                .is_some_and(|value| !value.is_null())
        {
            return Self::Enabled;
        }
        Self::Default
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Effort(effort) => effort.as_str(),
            Self::Adaptive => "adaptive",
            Self::Enabled => "enabled",
        }
    }

    #[cfg(feature = "metrics")]
    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Default => 0,
            Self::Effort(ReasoningEffort::None) => 1,
            Self::Effort(ReasoningEffort::Minimal) => 2,
            Self::Effort(ReasoningEffort::Low) => 3,
            Self::Effort(ReasoningEffort::Medium) => 4,
            Self::Effort(ReasoningEffort::High) => 5,
            Self::Effort(ReasoningEffort::Xhigh) => 6,
            Self::Effort(ReasoningEffort::Max) => 7,
            Self::Adaptive => 8,
            Self::Enabled => 9,
        }
    }

    fn from_wire(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" | "disabled" => Some(Self::Effort(ReasoningEffort::None)),
            "minimal" => Some(Self::Effort(ReasoningEffort::Minimal)),
            "low" => Some(Self::Effort(ReasoningEffort::Low)),
            "medium" => Some(Self::Effort(ReasoningEffort::Medium)),
            "high" => Some(Self::Effort(ReasoningEffort::High)),
            "xhigh" | "x-high" | "extra_high" | "extra-high" => {
                Some(Self::Effort(ReasoningEffort::Xhigh))
            }
            "max" | "maximum" => Some(Self::Effort(ReasoningEffort::Max)),
            "adaptive" => Some(Self::Adaptive),
            "enabled" => Some(Self::Enabled),
            _ => None,
        }
    }
}

impl RequestLogContext {
    /// Build a context after the upstream attempt has acquired its token reservation.
    pub(crate) fn new(
        metadata: RequestLogMetadata,
        throttle: ThrottleAcquisition,
        upstream_attempt: u32,
        metrics: MetricsRuntime,
    ) -> Self {
        let RequestLogMetadata {
            runtime_key,
            requested_model,
            resolved_model,
            peer,
            request_bytes,
            started,
            reasoning_setting,
            fallback_step,
        } = metadata;
        Self {
            runtime_key,
            requested_model,
            resolved_model,
            peer,
            request_bytes,
            started,
            reasoning_setting,
            throttle,
            upstream_attempt,
            fallback_step,
            metrics,
        }
    }

    /// Reconcile the local token reservation with reported upstream usage.
    pub(crate) async fn reconcile(&self, usage: ResponseTokenUsage) {
        self.throttle.reconcile(usage).await;
    }

    /// Reconcile and log one buffered embeddings request.
    pub(crate) async fn complete_embedding(&self, status: StatusCode, usage: ResponseTokenUsage) {
        self.reconcile(usage).await;
        self.complete_outcome(self.outcome(
            "/v1/embeddings",
            None,
            None,
            false,
            status,
            0,
            usage,
            true,
            false,
        ));
    }

    /// Log the point at which a successful upstream stream is connected.
    pub(crate) fn stream_connected(
        &self,
        client_wire: ClientWire,
        target: TargetWire,
        status: StatusCode,
    ) {
        self.metrics.stream_started();
        tracing::debug!(
            requested_model = %self.requested_model,
            resolved_model = %self.resolved_model,
            client_ip = %self.peer.ip(),
            client_port = self.peer.port(),
            request_bytes = self.request_bytes,
            raw_estimated_input_tokens = self.throttle.raw_estimated_input_tokens,
            estimate_factor = self.throttle.estimate_factor,
            estimated_input_tokens = self.throttle.estimated_input_tokens,
            reserved_output_tokens = self.throttle.reserved_output_tokens,
            estimated_tokens = self.throttle.estimated_tokens,
            upstream_attempt = self.upstream_attempt,
            fallback_step = self.fallback_step,
            token_throttle_mode = ?self.throttle.mode,
            token_throttle_active = self.throttle.active,
            token_limit_input = self.throttle.input_limit,
            token_window_budget = self.throttle.input_window_budget,
            token_penalty_basis_points = self.throttle.penalty_basis_points,
            token_queue_depth = self.throttle.queue_depth,
            token_reservation_input = self.throttle.reserved_input_tokens,
            token_window_used_before = self.throttle.input_window_used_before,
            token_window_wait_ms = self.throttle.wait.as_millis(),
            ?client_wire,
            ?target,
            streaming = true,
            status = status.as_u16(),
            latency_ms = self.started.elapsed().as_millis(),
            "model stream connected"
        );
    }

    /// Reconcile and log one buffered model request.
    pub(crate) async fn complete_model(
        &self,
        client_wire: ClientWire,
        target: TargetWire,
        streaming: bool,
        status: StatusCode,
        usage: ResponseTokenUsage,
    ) {
        self.reconcile(usage).await;
        self.complete_outcome(self.outcome(
            "/v1/model",
            Some(client_wire),
            Some(target),
            streaming,
            status,
            0,
            usage,
            true,
            false,
        ));
    }

    /// Log final body completion or cancellation for a streamed request.
    pub(crate) fn stream_completed(
        &self,
        client_wire: ClientWire,
        target: TargetWire,
        response_bytes: u64,
        usage: ResponseTokenUsage,
        status: StatusCode,
        finished: bool,
    ) {
        self.metrics.stream_finished();
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.metrics.record_in_band_rate_limit(&self.resolved_model);
        }
        self.complete_outcome(self.outcome(
            "/v1/model",
            Some(client_wire),
            Some(target),
            true,
            status,
            response_bytes,
            usage,
            finished,
            !status.is_success(),
        ));
    }

    #[allow(clippy::too_many_arguments)]
    fn outcome(
        &self,
        route: &'static str,
        client_wire: Option<ClientWire>,
        target: Option<TargetWire>,
        streaming: bool,
        status: StatusCode,
        response_bytes: u64,
        usage: ResponseTokenUsage,
        finished: bool,
        failed: bool,
    ) -> RequestOutcome {
        RequestOutcome {
            runtime_key: self.runtime_key.clone(),
            route,
            requested_model: self.requested_model.clone(),
            resolved_model: self.resolved_model.clone(),
            peer: self.peer,
            request_bytes: self.request_bytes,
            response_bytes,
            duration_ms: self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            client_wire,
            target,
            streaming,
            reasoning_setting: self.reasoning_setting,
            status,
            usage,
            throttle: self.throttle.clone(),
            upstream_attempt: self.upstream_attempt,
            fallback_step: self.fallback_step,
            finished,
            failed,
        }
    }

    fn complete_outcome(&self, outcome: RequestOutcome) {
        self.metrics.record_outcome(&outcome);
        emit_request_outcome(outcome);
    }
}

fn emit_request_outcome(outcome: RequestOutcome) {
    match completion_level(&outcome) {
        CompletionLevel::Warn => tracing::warn!(
            resolved_model = %outcome.resolved_model,
            route = outcome.route,
            client_wire = ?outcome.client_wire,
            target = ?outcome.target,
            streaming = outcome.streaming,
            status = outcome.status.as_u16(),
            duration_ms = outcome.duration_ms,
            fallback_step = outcome.fallback_step,
            failed = outcome.failed,
            "model request completed"
        ),
        CompletionLevel::Info => tracing::info!(
            resolved_model = %outcome.resolved_model,
            route = outcome.route,
            client_wire = ?outcome.client_wire,
            target = ?outcome.target,
            streaming = outcome.streaming,
            status = outcome.status.as_u16(),
            duration_ms = outcome.duration_ms,
            fallback_step = outcome.fallback_step,
            cancelled = outcome.streaming && !outcome.finished,
            "model request completed"
        ),
    }
    tracing::debug!(
        requested_model = %outcome.requested_model,
        resolved_model = %outcome.resolved_model,
        route = outcome.route,
        client_wire = ?outcome.client_wire,
        target = ?outcome.target,
        reasoning_setting = outcome.reasoning_setting.map(ReasoningSetting::label).unwrap_or("not-applicable"),
        streaming = outcome.streaming,
        status = outcome.status.as_u16(),
        duration_ms = outcome.duration_ms,
        client_ip = %outcome.peer.ip(),
        client_port = outcome.peer.port(),
        request_bytes = outcome.request_bytes,
        response_bytes = outcome.response_bytes,
        raw_estimated_input_tokens = outcome.throttle.raw_estimated_input_tokens,
        estimate_factor = outcome.throttle.estimate_factor,
        estimated_input_tokens = outcome.throttle.estimated_input_tokens,
        reserved_output_tokens = outcome.throttle.reserved_output_tokens,
        estimated_tokens = outcome.throttle.estimated_tokens,
        input_tokens = outcome.usage.input,
        output_tokens = outcome.usage.output,
        total_tokens = outcome.usage.total,
        upstream_attempt = outcome.upstream_attempt,
        fallback_step = outcome.fallback_step,
        token_throttle_mode = ?outcome.throttle.mode,
        token_throttle_active = outcome.throttle.active,
        token_limit_input = outcome.throttle.input_limit,
        token_window_budget = outcome.throttle.input_window_budget,
        token_penalty_basis_points = outcome.throttle.penalty_basis_points,
        token_queue_depth = outcome.throttle.queue_depth,
        token_reservation_input = outcome.throttle.reserved_input_tokens,
        token_window_used_before = outcome.throttle.input_window_used_before,
        token_window_wait_ms = outcome.throttle.wait.as_millis(),
        finished = outcome.finished,
        failed = outcome.failed,
        "model request details"
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CompletionLevel {
    Info,
    Warn,
}

fn completion_level(outcome: &RequestOutcome) -> CompletionLevel {
    if outcome.failed || outcome.status.is_server_error() {
        CompletionLevel::Warn
    } else {
        CompletionLevel::Info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::throttle::ThrottleAcquisition;

    fn outcome(status: StatusCode, failed: bool, finished: bool) -> RequestOutcome {
        RequestOutcome {
            runtime_key: "runtime".to_owned(),
            route: "/v1/model",
            requested_model: "model".to_owned(),
            resolved_model: "model".to_owned(),
            peer: "127.0.0.1:1".parse().unwrap(),
            request_bytes: 0,
            response_bytes: 0,
            duration_ms: 1,
            client_wire: None,
            target: None,
            streaming: !finished,
            reasoning_setting: Some(ReasoningSetting::Default),
            status,
            usage: ResponseTokenUsage::default(),
            throttle: ThrottleAcquisition::test_fixture(),
            upstream_attempt: 1,
            fallback_step: 0,
            finished,
            failed,
        }
    }

    #[test]
    fn successful_and_client_cancelled_completions_are_info() {
        assert_eq!(
            completion_level(&outcome(StatusCode::OK, false, true)),
            CompletionLevel::Info
        );
        assert_eq!(
            completion_level(&outcome(StatusCode::OK, false, false)),
            CompletionLevel::Info
        );
    }

    #[test]
    fn upstream_failures_and_5xx_completions_are_warn() {
        assert_eq!(
            completion_level(&outcome(StatusCode::BAD_GATEWAY, false, true)),
            CompletionLevel::Warn
        );
        assert_eq!(
            completion_level(&outcome(StatusCode::OK, true, false)),
            CompletionLevel::Warn
        );
    }

    #[cfg(feature = "metrics")]
    #[tokio::test]
    async fn in_band_stream_rate_limit_updates_error_and_rate_limit_metrics() {
        let metrics = MetricsRuntime::new(crate::metrics::MetricsConfig {
            mode: crate::metrics::MetricsMode::Collect,
            routes_visible: true,
        })
        .unwrap();
        metrics.activate_runtime("runtime".to_owned()).unwrap();
        let context = RequestLogContext::new(
            RequestLogMetadata {
                runtime_key: "runtime".to_owned(),
                requested_model: "requested".to_owned(),
                resolved_model: "resolved".to_owned(),
                peer: "127.0.0.1:1".parse().unwrap(),
                request_bytes: 1,
                started: Instant::now(),
                reasoning_setting: Some(ReasoningSetting::Default),
                fallback_step: 0,
            },
            ThrottleAcquisition::test_fixture(),
            1,
            metrics.clone(),
        );
        context.stream_connected(ClientWire::Responses, TargetWire::Responses, StatusCode::OK);
        context.stream_completed(
            ClientWire::Responses,
            TargetWire::Responses,
            1,
            ResponseTokenUsage::default(),
            StatusCode::TOO_MANY_REQUESTS,
            true,
        );

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.summary.total_rate_limited, 1);
        assert_eq!(snapshot.models[0].rate_limited, 1);
        assert_eq!(snapshot.models[0].errors, 1);
    }

    #[test]
    fn reasoning_settings_are_bounded_across_supported_request_shapes() {
        use serde_json::json;

        assert_eq!(
            ReasoningSetting::from_request(&json!({"reasoning_effort": "high"})),
            ReasoningSetting::Effort(ReasoningEffort::High)
        );
        assert_eq!(
            ReasoningSetting::from_request(&json!({"reasoning": {"effort": "x-high"}})),
            ReasoningSetting::Effort(ReasoningEffort::Xhigh)
        );
        assert_eq!(
            ReasoningSetting::from_request(&json!({"thinking": {"type": "adaptive"}})),
            ReasoningSetting::Adaptive
        );
        assert_eq!(
            ReasoningSetting::from_request(&json!({"thinkingConfig": {"thinkingBudget": 0}})),
            ReasoningSetting::Effort(ReasoningEffort::None)
        );
        assert_eq!(
            ReasoningSetting::from_request(&json!({"reasoning": {"effort": "provider-new"}})),
            ReasoningSetting::Enabled
        );
        assert_eq!(
            ReasoningSetting::from_request(&json!({"model": "example"})),
            ReasoningSetting::Default
        );
    }
}
