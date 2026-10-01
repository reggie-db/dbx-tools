//! Shared request-completion logging for buffered and streaming routes.

use std::{net::SocketAddr, time::Instant};

use axum::http::StatusCode;

use crate::{
    metrics::MetricsRuntime,
    protocol::{ClientWire, TargetWire},
    throttle::{ResponseTokenUsage, ThrottleAcquisition},
};

/// One completed request consumed by logging and process-local metrics.
#[derive(Debug)]
pub(crate) struct RequestOutcome {
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
    pub(crate) status: StatusCode,
    pub(crate) usage: ResponseTokenUsage,
    pub(crate) throttle: ThrottleAcquisition,
    pub(crate) upstream_attempt: u32,
    pub(crate) finished: bool,
    pub(crate) failed: bool,
}

/// Request metadata shared by buffered and streamed completion events.
#[derive(Debug)]
pub(crate) struct RequestLogContext {
    requested_model: String,
    resolved_model: String,
    peer: SocketAddr,
    request_bytes: usize,
    started: Instant,
    throttle: ThrottleAcquisition,
    upstream_attempt: u32,
    metrics: MetricsRuntime,
}

/// Request fields captured before upstream admission.
#[derive(Debug)]
pub(crate) struct RequestLogMetadata {
    pub(crate) requested_model: String,
    pub(crate) resolved_model: String,
    pub(crate) peer: SocketAddr,
    pub(crate) request_bytes: usize,
    pub(crate) started: Instant,
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
            requested_model,
            resolved_model,
            peer,
            request_bytes,
            started,
        } = metadata;
        Self {
            requested_model,
            resolved_model,
            peer,
            request_bytes,
            started,
            throttle,
            upstream_attempt,
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
        finished: bool,
        failed: bool,
    ) {
        self.metrics.stream_finished();
        self.complete_outcome(self.outcome(
            "/v1/model",
            Some(client_wire),
            Some(target),
            true,
            StatusCode::OK,
            response_bytes,
            usage,
            finished,
            failed,
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
            status,
            usage,
            throttle: self.throttle.clone(),
            upstream_attempt: self.upstream_attempt,
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
            status,
            usage: ResponseTokenUsage::default(),
            throttle: ThrottleAcquisition::test_fixture(),
            upstream_attempt: 1,
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
}
