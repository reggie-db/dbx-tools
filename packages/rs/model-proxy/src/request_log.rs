//! Shared request-completion logging for buffered and streaming routes.

use std::{net::SocketAddr, time::Instant};

use axum::http::StatusCode;

use crate::{
    protocol::{ClientWire, TargetWire},
    throttle::{ResponseTokenUsage, ThrottleAcquisition},
};

macro_rules! log_request {
    ($context:expr, $($fields:tt)*) => {
        tracing::info!(
            requested_model = %$context.requested_model,
            resolved_model = %$context.resolved_model,
            client_ip = %$context.peer.ip(),
            client_port = $context.peer.port(),
            request_bytes = $context.request_bytes,
            raw_estimated_input_tokens = $context.throttle.raw_estimated_input_tokens,
            estimate_factor = $context.throttle.estimate_factor,
            estimated_input_tokens = $context.throttle.estimated_input_tokens,
            reserved_output_tokens = $context.throttle.reserved_output_tokens,
            estimated_tokens = $context.throttle.estimated_tokens,
            upstream_attempt = $context.upstream_attempt,
            token_throttle_mode = ?$context.throttle.mode,
            token_throttle_active = $context.throttle.active,
            token_limit_input = $context.throttle.input_limit,
            token_reservation_input = $context.throttle.reserved_input_tokens,
            token_window_used_before = $context.throttle.input_window_used_before,
            token_window_wait_ms = $context.throttle.wait.as_millis(),
            oversized_request = false,
            $($fields)*
        );
    };
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
}

impl RequestLogContext {
    /// Build a context after the upstream attempt has acquired its token reservation.
    pub(crate) fn new(
        requested_model: String,
        resolved_model: String,
        peer: SocketAddr,
        request_bytes: usize,
        started: Instant,
        throttle: ThrottleAcquisition,
        upstream_attempt: u32,
    ) -> Self {
        Self {
            requested_model,
            resolved_model,
            peer,
            request_bytes,
            started,
            throttle,
            upstream_attempt,
        }
    }

    /// Reconcile the local token reservation with reported upstream usage.
    pub(crate) async fn reconcile(&self, usage: ResponseTokenUsage) {
        self.throttle.reconcile(usage).await;
    }

    /// Reconcile and log one buffered embeddings request.
    pub(crate) async fn complete_embedding(&self, status: StatusCode, usage: ResponseTokenUsage) {
        self.reconcile(usage).await;
        log_request!(
            self,
            route = "/v1/embeddings",
            status = status.as_u16(),
            input_tokens = usage.input,
            output_tokens = usage.output,
            total_tokens = usage.total,
            latency_ms = self.started.elapsed().as_millis(),
            "embedding request completed"
        );
    }

    /// Log the point at which a successful upstream stream is connected.
    pub(crate) fn stream_connected(
        &self,
        client_wire: ClientWire,
        target: TargetWire,
        status: StatusCode,
    ) {
        log_request!(
            self,
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
        log_request!(
            self,
            ?client_wire,
            ?target,
            streaming,
            status = status.as_u16(),
            input_tokens = usage.input,
            output_tokens = usage.output,
            total_tokens = usage.total,
            latency_ms = self.started.elapsed().as_millis(),
            "model request completed"
        );
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
        log_request!(
            self,
            ?client_wire,
            ?target,
            streaming = true,
            response_bytes,
            input_tokens = usage.input,
            output_tokens = usage.output,
            total_tokens = usage.total,
            duration_ms = self.started.elapsed().as_millis(),
            finished,
            failed,
            "model stream completed"
        );
    }
}
