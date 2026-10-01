//! Optional per-workspace, per-model token reservation queue.

use std::{
    collections::{HashMap, VecDeque},
    num::NonZeroU64,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use clap::ValueEnum;
use dbx_tools_model::{ModelClass, ModelRateLimitCatalogue};
use serde_json::Value;
use tokenx_rs::estimate_token_count;
use tokio::{
    sync::{Mutex, Notify},
    time::Instant,
};

use crate::adaptive::{AutoLimiter, AutoRecoveryPolicy, AutoTransition, AutoTransitionKind};

const WINDOW: Duration = Duration::from_secs(60);
const CLAUDE_SONNET_4_DEFAULT_OUTPUT_TOKENS: u64 = 1_000;
const CALIBRATION_ALPHA: f64 = 0.25;
const CALIBRATION_MIN_SAMPLES: u32 = 3;
const CALIBRATION_DEADBAND: f64 = 0.05;
const CALIBRATION_MIN_FACTOR: f64 = 0.25;
const CALIBRATION_MAX_FACTOR: f64 = 4.0;

/// Activation policy for process-local pay-per-token admission control.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub(crate) enum RateLimitMode {
    /// Activate a workspace/model key after its first input-token 429.
    #[default]
    Auto,
    /// Apply documented or configured TPM budgets immediately.
    On,
    /// Disable process-local TPM admission.
    Off,
}

#[derive(Clone, Debug)]
pub(crate) struct RequestThrottle {
    workspace: Arc<str>,
    input_tokens_per_minute: Option<NonZeroU64>,
    output_tokens_per_minute: Option<NonZeroU64>,
    provisioned_throughput: bool,
    mode: RateLimitMode,
    documented_limits: ModelRateLimitCatalogue,
    queues: Arc<Mutex<HashMap<ThrottleKey, Arc<TokenQueue>>>>,
    counters: Arc<ThrottleCounters>,
    auto_recovery_policy: AutoRecoveryPolicy,
}

/// Configuration for process-local pay-per-token admission control.
#[derive(Clone, Debug)]
pub(crate) struct ThrottleConfig {
    /// Optional input-rate override.
    pub(crate) input_tokens_per_minute: Option<NonZeroU64>,
    /// Optional output-rate override.
    pub(crate) output_tokens_per_minute: Option<NonZeroU64>,
    /// Whether the selected endpoints use provisioned throughput.
    pub(crate) provisioned_throughput: bool,
    /// Process-local token-rate activation policy.
    pub(crate) mode: RateLimitMode,
    /// Cached Databricks pay-per-token limits.
    pub(crate) documented_limits: ModelRateLimitCatalogue,
}

/// Token estimate and time spent waiting for a local reservation.
#[derive(Clone, Debug)]
pub(crate) struct ThrottleAcquisition {
    /// Time spent waiting for capacity in the local queue.
    pub(crate) wait: Duration,
    /// Estimated input tokens reserved for the request.
    pub(crate) estimated_input_tokens: u64,
    /// Uncalibrated input estimate produced by tokenx.
    pub(crate) raw_estimated_input_tokens: u64,
    /// Process-local model calibration applied to the raw estimate.
    pub(crate) estimate_factor: f64,
    /// Requested or documented default output tokens reserved for the request.
    pub(crate) reserved_output_tokens: u64,
    /// Estimated input plus reserved output tokens.
    pub(crate) estimated_tokens: u64,
    /// Configured activation mode.
    pub(crate) mode: RateLimitMode,
    /// Whether token admission was active for this attempt.
    pub(crate) active: bool,
    /// Input-token budget applied to this attempt.
    pub(crate) input_limit: Option<u64>,
    /// Effective rolling input budget applied to this attempt.
    pub(crate) input_window_budget: Option<u64>,
    /// Temporary automatic input-budget penalty.
    pub(crate) penalty_basis_points: u16,
    /// Admission queue depth observed before this attempt acquired the FIFO lock.
    pub(crate) queue_depth: u64,
    /// Input tokens reserved in the local window.
    pub(crate) reserved_input_tokens: u64,
    /// Input tokens already reserved before this attempt.
    pub(crate) input_window_used_before: u64,
    reservation: Option<ThrottleReservation>,
}

/// Local rejection for a request larger than its active input-token budget.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OversizedInput {
    /// Calibrated input estimate.
    pub(crate) estimated_input_tokens: u64,
    /// Active input-token budget.
    pub(crate) input_limit: u64,
    /// Input tokens already reserved in the current window.
    pub(crate) input_window_used_before: u64,
    /// Configured activation mode.
    pub(crate) mode: RateLimitMode,
}

/// Result of evaluating an upstream 429 for automatic token admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AutoActivation {
    /// The response was not a matching automatic activation signal.
    Ignored,
    /// The response matched but no local input budget is known.
    Unavailable,
    /// Automatic congestion state changed or reset.
    Transition(AutoTransition),
}

/// Token usage reported by a completed upstream response.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ResponseTokenUsage {
    /// Whether the upstream response included a usage object.
    pub(crate) reported: bool,
    /// Input or prompt tokens consumed.
    pub(crate) input: u64,
    /// Output or completion tokens consumed.
    pub(crate) output: u64,
    /// Total tokens consumed.
    pub(crate) total: u64,
}

impl ThrottleAcquisition {
    #[cfg(test)]
    pub(crate) fn test_fixture() -> Self {
        Self {
            wait: Duration::ZERO,
            estimated_input_tokens: 1,
            raw_estimated_input_tokens: 1,
            estimate_factor: 1.0,
            reserved_output_tokens: 0,
            estimated_tokens: 1,
            mode: RateLimitMode::Auto,
            active: false,
            input_limit: None,
            input_window_budget: None,
            penalty_basis_points: 0,
            queue_depth: 1,
            reserved_input_tokens: 0,
            input_window_used_before: 0,
            reservation: None,
        }
    }

    /// Replace estimated reservations with reported upstream usage.
    pub(crate) async fn reconcile(&self, usage: ResponseTokenUsage) {
        let Some(reservation) = self.reservation.as_ref().filter(|_| usage.reported) else {
            return;
        };
        let mut state = reservation.queue.state.lock().await;
        if usage.input > 0 {
            state
                .calibration
                .observe(reservation.raw_estimated_input, usage.input);
            state.input.reconcile(reservation.id, usage.input);
        }
        state.output.reconcile(reservation.id, usage.output);
        drop(state);
        reservation.queue.notify.notify_waiters();
    }

    /// Remove a reservation for an attempt rejected before token consumption.
    pub(crate) async fn release(&self) {
        let Some(reservation) = self.reservation.as_ref() else {
            return;
        };
        let mut state = reservation.queue.state.lock().await;
        state.input.remove(reservation.id);
        state.output.remove(reservation.id);
        drop(state);
        reservation.queue.notify.notify_waiters();
    }

    /// Return the number of requests currently waiting on this model queue.
    #[cfg(feature = "metrics")]
    pub(crate) fn current_queue_depth(&self) -> u64 {
        self.reservation
            .as_ref()
            .map(|reservation| reservation.queue.queue_depth.load(Ordering::Relaxed))
            .unwrap_or_default()
    }
}

impl RequestThrottle {
    pub(crate) fn new(workspace: &str, config: ThrottleConfig) -> Self {
        Self {
            workspace: Arc::from(workspace),
            input_tokens_per_minute: config.input_tokens_per_minute,
            output_tokens_per_minute: config.output_tokens_per_minute,
            provisioned_throughput: config.provisioned_throughput,
            mode: config.mode,
            documented_limits: config.documented_limits,
            queues: Arc::default(),
            counters: Arc::default(),
            auto_recovery_policy: AutoRecoveryPolicy::default(),
        }
    }

    #[cfg(test)]
    fn with_auto_recovery_policy(mut self, policy: AutoRecoveryPolicy) -> Self {
        self.auto_recovery_policy = policy;
        self
    }

    /// Estimate the model-visible input and requested output reservation.
    pub(crate) fn estimate(&self, model: &str, request: &Value) -> TokenEstimate {
        token_estimate(model, request)
    }

    /// Admit one upstream attempt through the active token window.
    pub(crate) async fn acquire(
        &self,
        model: &str,
        model_class: Option<ModelClass>,
        estimate: TokenEstimate,
    ) -> Result<ThrottleAcquisition, OversizedInput> {
        let queue = self.queue(model).await;
        let configured_limits = self.limits(model, model_class);
        let result = reserve(
            Arc::clone(&queue),
            estimate,
            configured_limits,
            self.mode,
            WINDOW,
        )
        .await;
        match result {
            Ok(acquisition) => {
                if !acquisition.active
                    && self.mode == RateLimitMode::Auto
                    && configured_limits.input.is_some_and(|limits| {
                        acquisition.estimated_input_tokens
                            >= limits.request_ceiling.saturating_mul(4) / 5
                    })
                    && !queue.cold_warning.swap(true, Ordering::AcqRel)
                {
                    tracing::warn!(
                        workspace = self.workspace.as_ref(),
                        model,
                        estimated_input_tokens = acquisition.estimated_input_tokens,
                        token_limit_input = configured_limits
                            .input
                            .map(|limits| limits.request_ceiling),
                        token_throttle_mode = ?self.mode,
                        token_throttle_active = false,
                        "automatic token throttling is inactive for a near-limit request"
                    );
                }
                if !acquisition.wait.is_zero() {
                    self.counters
                        .admission_waits
                        .fetch_add(1, Ordering::Relaxed);
                }
                Ok(acquisition)
            }
            Err(error) => {
                self.counters
                    .oversized_rejections
                    .fetch_add(1, Ordering::Relaxed);
                Err(error)
            }
        }
    }

    /// Activate automatic TPM admission after a matching Databricks 429.
    pub(crate) async fn activate_from_message(
        &self,
        model: &str,
        model_class: Option<ModelClass>,
        message: Option<&str>,
    ) -> AutoActivation {
        if self.provisioned_throughput
            || self.mode != RateLimitMode::Auto
            || !message.is_some_and(is_input_limit_message)
        {
            return AutoActivation::Ignored;
        }
        let Some(base_input_budget) = self
            .limits(model, model_class)
            .input
            .map(|limits| limits.request_ceiling)
        else {
            return AutoActivation::Unavailable;
        };
        let queue = self.queue(model).await;
        let transition = {
            let mut state = queue.state.lock().await;
            state.adaptive.record_input_429(
                Instant::now(),
                base_input_budget,
                self.auto_recovery_policy,
            )
        };
        match transition.kind {
            AutoTransitionKind::Activated => {
                self.counters
                    .automatic_activations
                    .fetch_add(1, Ordering::Relaxed);
            }
            AutoTransitionKind::Reactivated => {
                self.counters
                    .automatic_activations
                    .fetch_add(1, Ordering::Relaxed);
                self.counters
                    .automatic_reactivations
                    .fetch_add(1, Ordering::Relaxed);
            }
            AutoTransitionKind::Tightened => {
                self.counters
                    .automatic_tightenings
                    .fetch_add(1, Ordering::Relaxed);
            }
            _ => unreachable!("input 429 only activates or tightens"),
        }
        queue.notify.notify_waiters();
        AutoActivation::Transition(transition)
    }

    /// Count a successful upstream response and lazily advance automatic recovery.
    pub(crate) async fn record_success(
        &self,
        model: &str,
        model_class: Option<ModelClass>,
    ) -> Option<AutoTransition> {
        if self.provisioned_throughput || self.mode != RateLimitMode::Auto {
            return None;
        }
        let base_input_budget = self
            .limits(model, model_class)
            .input
            .map(|limits| limits.request_ceiling)?;
        let queue = self.queue(model).await;
        let transition = {
            let mut state = queue.state.lock().await;
            state.adaptive.record_success(
                Instant::now(),
                base_input_budget,
                self.auto_recovery_policy,
            )
        }?;
        match transition.kind {
            AutoTransitionKind::Relaxed => {
                self.counters
                    .automatic_relaxations
                    .fetch_add(1, Ordering::Relaxed);
            }
            AutoTransitionKind::Deactivated => {
                self.counters
                    .automatic_deactivations
                    .fetch_add(1, Ordering::Relaxed);
            }
            _ => unreachable!("success only relaxes or deactivates"),
        }
        queue.notify.notify_waiters();
        Some(transition)
    }

    /// Return the local input-window delay for another attempt when known.
    pub(crate) async fn token_window_delay(
        &self,
        model: &str,
        model_class: Option<ModelClass>,
        estimate: TokenEstimate,
    ) -> Option<Duration> {
        let queue = self.queue(model).await;
        if !self.enabled(&queue).await {
            return None;
        }
        let base_input_limit = self.limits(model, model_class).input?;
        let now = Instant::now();
        let mut state = queue.state.lock().await;
        let input_limit = match self.mode {
            RateLimitMode::Auto => state
                .adaptive
                .effective_input_budget(base_input_limit.request_ceiling)?,
            RateLimitMode::On => base_input_limit.window_budget,
            RateLimitMode::Off => return None,
        };
        state.input.prune(now, WINDOW);
        let adjusted_input = state.calibration.apply(estimate.input);
        (adjusted_input <= base_input_limit.request_ceiling)
            .then(|| {
                state
                    .input
                    .delay_with_burst(now, adjusted_input, input_limit, WINDOW)
            })
            .flatten()
    }

    /// Record an input-token 429 received after local token admission.
    pub(crate) fn record_input_429_after_admission(&self) {
        self.counters
            .input_429_after_admission
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record a retry that reacquired local token admission.
    pub(crate) fn record_retry_reacquisition(&self) {
        self.counters
            .retry_reacquisitions
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record use of the conservative full-window retry delay.
    pub(crate) fn record_fallback_window_delay(&self) {
        self.counters
            .fallback_window_delays
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Snapshot process-local rate-limit counters.
    pub(crate) async fn counters(&self) -> ThrottleCounterSnapshot {
        let queues = self
            .queues
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut auto_active_keys = 0;
        for queue in queues {
            let snapshot = queue.state.lock().await.adaptive.snapshot();
            auto_active_keys += u64::from(snapshot.active);
        }
        ThrottleCounterSnapshot {
            automatic_activations: self.counters.automatic_activations.load(Ordering::Relaxed),
            automatic_tightenings: self.counters.automatic_tightenings.load(Ordering::Relaxed),
            automatic_relaxations: self.counters.automatic_relaxations.load(Ordering::Relaxed),
            automatic_deactivations: self
                .counters
                .automatic_deactivations
                .load(Ordering::Relaxed),
            automatic_reactivations: self
                .counters
                .automatic_reactivations
                .load(Ordering::Relaxed),
            auto_active_keys,
            admission_waits: self.counters.admission_waits.load(Ordering::Relaxed),
            oversized_rejections: self.counters.oversized_rejections.load(Ordering::Relaxed),
            input_429_after_admission: self
                .counters
                .input_429_after_admission
                .load(Ordering::Relaxed),
            retry_reacquisitions: self.counters.retry_reacquisitions.load(Ordering::Relaxed),
            fallback_window_delays: self.counters.fallback_window_delays.load(Ordering::Relaxed),
        }
    }

    /// Snapshot current token-window and queue capacity by actual model.
    pub(crate) async fn capacity_snapshots(&self) -> Vec<ThrottleModelSnapshot> {
        let queues = self
            .queues
            .lock()
            .await
            .iter()
            .map(|(key, queue)| (key.model.to_string(), Arc::clone(queue)))
            .collect::<Vec<_>>();
        let now = Instant::now();
        let mut snapshots = Vec::with_capacity(queues.len());
        for (model, queue) in queues {
            let configured = self.limits(&model, None).input;
            let mut state = queue.state.lock().await;
            state.input.prune(now, WINDOW);
            let adaptive = state.adaptive.snapshot();
            let (active, effective_input_budget, penalty_basis_points) = if self
                .provisioned_throughput
            {
                (false, None, 0)
            } else {
                match self.mode {
                    RateLimitMode::Auto if adaptive.active => (
                        true,
                        configured.and_then(|limits| {
                            state
                                .adaptive
                                .effective_input_budget(limits.request_ceiling)
                        }),
                        adaptive.penalty_basis_points,
                    ),
                    RateLimitMode::On => (true, configured.map(|limits| limits.window_budget), 0),
                    RateLimitMode::Auto | RateLimitMode::Off => (false, None, 0),
                }
            };
            snapshots.push(ThrottleModelSnapshot {
                model,
                active,
                input_limit: configured.map(|limits| limits.request_ceiling),
                effective_input_budget,
                input_window_used: effective_input_budget.map(|_| state.input.reserved_tokens),
                penalty_basis_points,
                queue_depth: queue.queue_depth.load(Ordering::Relaxed),
            });
        }
        snapshots
    }

    async fn queue(&self, model: &str) -> Arc<TokenQueue> {
        let key = ThrottleKey {
            workspace: self.workspace.clone(),
            model: Arc::from(model),
        };
        let mut queues = self.queues.lock().await;
        queues.entry(key).or_default().clone()
    }

    async fn enabled(&self, queue: &TokenQueue) -> bool {
        if self.provisioned_throughput {
            return false;
        }
        match self.mode {
            RateLimitMode::Auto => queue.state.lock().await.adaptive.snapshot().active,
            RateLimitMode::On => true,
            RateLimitMode::Off => false,
        }
    }

    fn limits(&self, model: &str, model_class: Option<ModelClass>) -> TokenLimits {
        if self.provisioned_throughput {
            return TokenLimits::default();
        }
        let documented = if model_class == Some(ModelClass::Embedding) {
            None
        } else {
            self.documented_limits.limits_for_name(model)
        };
        TokenLimits {
            input: self
                .input_tokens_per_minute
                .map(NonZeroU64::get)
                .or_else(|| documented.and_then(|limits| limits.input_tokens_per_minute))
                .map(InputTokenLimits::full),
            output: self
                .output_tokens_per_minute
                .map(NonZeroU64::get)
                .or_else(|| documented.and_then(|limits| limits.output_tokens_per_minute)),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ThrottleKey {
    workspace: Arc<str>,
    model: Arc<str>,
}

#[derive(Debug, Default)]
struct ThrottleCounters {
    automatic_activations: AtomicU64,
    automatic_tightenings: AtomicU64,
    automatic_relaxations: AtomicU64,
    automatic_deactivations: AtomicU64,
    automatic_reactivations: AtomicU64,
    admission_waits: AtomicU64,
    oversized_rejections: AtomicU64,
    input_429_after_admission: AtomicU64,
    retry_reacquisitions: AtomicU64,
    fallback_window_delays: AtomicU64,
}

/// Process-local rate-limit counters exposed through the health route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ThrottleCounterSnapshot {
    pub(crate) automatic_activations: u64,
    pub(crate) automatic_tightenings: u64,
    pub(crate) automatic_relaxations: u64,
    pub(crate) automatic_deactivations: u64,
    pub(crate) automatic_reactivations: u64,
    pub(crate) auto_active_keys: u64,
    pub(crate) admission_waits: u64,
    pub(crate) oversized_rejections: u64,
    pub(crate) input_429_after_admission: u64,
    pub(crate) retry_reacquisitions: u64,
    pub(crate) fallback_window_delays: u64,
}

/// Live process-local capacity for one actual model queue.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ThrottleModelSnapshot {
    pub(crate) model: String,
    pub(crate) active: bool,
    pub(crate) input_limit: Option<u64>,
    pub(crate) effective_input_budget: Option<u64>,
    pub(crate) input_window_used: Option<u64>,
    pub(crate) penalty_basis_points: u16,
    pub(crate) queue_depth: u64,
}

#[derive(Debug, Default)]
struct TokenQueue {
    /// Admission is acquired before state; no code may acquire them in reverse order.
    admission: Mutex<()>,
    queue_depth: AtomicU64,
    cold_warning: AtomicBool,
    state: Mutex<WindowState>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct WindowState {
    next_id: u64,
    adaptive: AutoLimiter,
    calibration: InputCalibration,
    input: TokenWindow,
    output: TokenWindow,
}

#[derive(Clone, Debug)]
struct ThrottleReservation {
    queue: Arc<TokenQueue>,
    id: u64,
    raw_estimated_input: u64,
}

struct QueueDepthGuard(Arc<TokenQueue>);

impl Drop for QueueDepthGuard {
    fn drop(&mut self) {
        self.0.queue_depth.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug)]
struct Reservation {
    id: u64,
    reserved_at: Instant,
    tokens: u64,
}

#[derive(Debug, Default)]
struct TokenWindow {
    reservations: VecDeque<Reservation>,
    reserved_tokens: u64,
}

impl TokenWindow {
    fn prune(&mut self, now: Instant, window: Duration) {
        while self
            .reservations
            .front()
            .is_some_and(|reservation| now.duration_since(reservation.reserved_at) >= window)
        {
            let reservation = self
                .reservations
                .pop_front()
                .expect("front reservation exists");
            self.reserved_tokens = self.reserved_tokens.saturating_sub(reservation.tokens);
        }
    }

    fn delay(&self, now: Instant, tokens: u64, limit: u64, window: Duration) -> Option<Duration> {
        if self.reserved_tokens.saturating_add(tokens) <= limit {
            return None;
        }
        self.reservations
            .front()
            .map(|reservation| window.saturating_sub(now.duration_since(reservation.reserved_at)))
    }

    fn delay_with_burst(
        &self,
        now: Instant,
        tokens: u64,
        window_budget: u64,
        window: Duration,
    ) -> Option<Duration> {
        if tokens > window_budget && self.reservations.is_empty() {
            return None;
        }
        self.delay(now, tokens, window_budget, window)
    }

    fn reserve(&mut self, id: u64, now: Instant, tokens: u64) {
        self.reservations.push_back(Reservation {
            id,
            reserved_at: now,
            tokens,
        });
        self.reserved_tokens = self.reserved_tokens.saturating_add(tokens);
    }

    fn reconcile(&mut self, id: u64, actual: u64) {
        let Some(reservation) = self
            .reservations
            .iter_mut()
            .find(|reservation| reservation.id == id)
        else {
            return;
        };
        self.reserved_tokens = self
            .reserved_tokens
            .saturating_sub(reservation.tokens)
            .saturating_add(actual);
        reservation.tokens = actual;
    }

    fn remove(&mut self, id: u64) {
        let Some(index) = self
            .reservations
            .iter()
            .position(|reservation| reservation.id == id)
        else {
            return;
        };
        let reservation = self
            .reservations
            .remove(index)
            .expect("reservation index exists");
        self.reserved_tokens = self.reserved_tokens.saturating_sub(reservation.tokens);
    }
}

/// Pre-admission model-visible input estimate and output reservation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct TokenEstimate {
    /// Raw input estimate before per-model calibration.
    pub(crate) input: u64,
    /// Caller-selected or documented default output capacity.
    pub(crate) output: u64,
}

/// Bounded per-model ratio between raw estimates and reported input usage.
#[derive(Clone, Copy, Debug)]
struct InputCalibration {
    samples: u32,
    ratio: f64,
}

impl Default for InputCalibration {
    fn default() -> Self {
        Self {
            samples: 0,
            ratio: 1.0,
        }
    }
}

impl InputCalibration {
    fn observe(&mut self, estimated: u64, actual: u64) {
        if estimated == 0 || actual == 0 {
            return;
        }
        let observed = (actual as f64 / estimated as f64)
            .clamp(CALIBRATION_MIN_FACTOR, CALIBRATION_MAX_FACTOR);
        self.ratio = if self.samples == 0 {
            observed
        } else {
            self.ratio * (1.0 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA
        };
        self.samples = self.samples.saturating_add(1);
    }

    fn factor(self) -> f64 {
        if self.samples < CALIBRATION_MIN_SAMPLES
            || (self.ratio - 1.0).abs() <= CALIBRATION_DEADBAND
        {
            1.0
        } else {
            self.ratio
        }
    }

    fn apply(self, estimate: u64) -> u64 {
        ((estimate as f64 * self.factor()).ceil()).clamp(1.0, u64::MAX as f64) as u64
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TokenLimits {
    input: Option<InputTokenLimits>,
    output: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct InputTokenLimits {
    request_ceiling: u64,
    window_budget: u64,
}

impl InputTokenLimits {
    fn full(limit: u64) -> Self {
        Self {
            request_ceiling: limit,
            window_budget: limit,
        }
    }
}

async fn reserve(
    queue: Arc<TokenQueue>,
    estimate: TokenEstimate,
    configured_limits: TokenLimits,
    mode: RateLimitMode,
    window: Duration,
) -> Result<ThrottleAcquisition, OversizedInput> {
    let started = Instant::now();
    let queue_depth = queue.queue_depth.fetch_add(1, Ordering::Relaxed) + 1;
    let _queue_depth = QueueDepthGuard(Arc::clone(&queue));
    let _admission = queue.admission.lock().await;
    loop {
        let notified = queue.notify.notified();
        let delay = {
            let now = Instant::now();
            let mut state = queue.state.lock().await;
            let adaptive = state.adaptive.snapshot();
            let (active, limits) = match mode {
                RateLimitMode::Auto if adaptive.active => (
                    true,
                    TokenLimits {
                        input: configured_limits.input.map(|limits| InputTokenLimits {
                            request_ceiling: limits.request_ceiling,
                            window_budget: state
                                .adaptive
                                .effective_input_budget(limits.request_ceiling)
                                .unwrap_or(limits.window_budget),
                        }),
                        output: configured_limits.output,
                    },
                ),
                RateLimitMode::Auto | RateLimitMode::Off => (false, TokenLimits::default()),
                RateLimitMode::On => (true, configured_limits),
            };
            let output_tokens = limits
                .output
                .map(|limit| estimate.output.min(limit))
                .unwrap_or_default();
            let estimate_factor = state.calibration.factor();
            let adjusted_input = state.calibration.apply(estimate.input);
            state.input.prune(now, window);
            state.output.prune(now, window);
            let input_window_used_before = state.input.reserved_tokens;
            if let Some(input_limits) = limits.input {
                if adjusted_input > input_limits.request_ceiling {
                    return Err(OversizedInput {
                        estimated_input_tokens: adjusted_input,
                        input_limit: input_limits.request_ceiling,
                        input_window_used_before,
                        mode,
                    });
                }
            }
            let input_tokens = limits.input.map(|_| adjusted_input).unwrap_or_default();
            let delay = [
                limits.input.and_then(|limits| {
                    state
                        .input
                        .delay_with_burst(now, input_tokens, limits.window_budget, window)
                }),
                limits
                    .output
                    .and_then(|limit| state.output.delay(now, output_tokens, limit, window)),
            ]
            .into_iter()
            .flatten()
            .max();
            if delay.is_none() {
                let id = state.next_id;
                state.next_id = state.next_id.wrapping_add(1);
                if limits.input.is_some() {
                    state.input.reserve(id, now, input_tokens);
                }
                if limits.output.is_some() {
                    state.output.reserve(id, now, output_tokens);
                }
                return Ok(ThrottleAcquisition {
                    wait: started.elapsed(),
                    estimated_input_tokens: adjusted_input,
                    raw_estimated_input_tokens: estimate.input,
                    estimate_factor,
                    reserved_output_tokens: estimate.output,
                    estimated_tokens: adjusted_input.saturating_add(estimate.output),
                    mode,
                    active,
                    input_limit: configured_limits.input.map(|limits| limits.request_ceiling),
                    input_window_budget: limits.input.map(|limits| limits.window_budget),
                    penalty_basis_points: adaptive.penalty_basis_points,
                    queue_depth,
                    reserved_input_tokens: input_tokens,
                    input_window_used_before,
                    reservation: Some(ThrottleReservation {
                        queue: Arc::clone(&queue),
                        id,
                        raw_estimated_input: estimate.input,
                    }),
                });
            }
            delay
        };
        if let Some(delay) = delay {
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = notified => {}
            }
        }
    }
}

/// Estimate input tokens with tokenx and reserve caller-selected output capacity.
fn token_estimate(model: &str, request: &Value) -> TokenEstimate {
    let input = estimate_rendered_tokens(request, None).max(1);
    TokenEstimate {
        input,
        output: requested_output_tokens(model, request),
    }
}

/// Estimate model-visible JSON while excluding opaque binary and encrypted fields.
fn estimate_rendered_tokens(value: &Value, field: Option<&str>) -> u64 {
    if field.is_some_and(opaque_field) {
        return 0;
    }
    match value {
        Value::Null => 0,
        Value::Bool(_) | Value::Number(_) => 1,
        Value::String(value) if value.starts_with("data:") => 0,
        Value::String(value) => estimate_token_count(value) as u64,
        Value::Array(values) => values.iter().fold(0, |total, value| {
            total.saturating_add(estimate_rendered_tokens(value, None))
        }),
        Value::Object(values) => {
            let base64_data = values.get("type").and_then(Value::as_str) == Some("base64");
            values.iter().fold(0_u64, |total, (name, value)| {
                if base64_data && name == "data" {
                    return total;
                }
                total
                    .saturating_add(estimate_token_count(name) as u64)
                    .saturating_add(estimate_rendered_tokens(value, Some(name)))
            })
        }
    }
}

/// Return whether a field carries bytes or encrypted state rather than rendered text.
fn opaque_field(field: &str) -> bool {
    matches!(
        field,
        "encrypted_content"
            | "signature"
            | "image_url"
            | "file_data"
            | "file_url"
            | "audio_data"
            | "screenshot"
    )
}

/// Match the Databricks workspace input-token rejection independently of case.
pub(crate) fn is_input_limit_message(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("exceeded workspace input tokens")
}

fn requested_output_tokens(model: &str, request: &Value) -> u64 {
    ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .into_iter()
        .find_map(|field| request.get(field).and_then(Value::as_u64))
        .unwrap_or_else(|| {
            let model = model.to_ascii_lowercase();
            if model.contains("claude-sonnet-4") {
                CLAUDE_SONNET_4_DEFAULT_OUTPUT_TOKENS
            } else {
                0
            }
        })
}

/// Read OpenAI, Responses, or Anthropic token usage from a buffered response.
pub(crate) fn response_token_usage(response: &Value) -> ResponseTokenUsage {
    let usage = response
        .get("usage")
        .or_else(|| response.get("response")?.get("usage"));
    let Some(usage) = usage else {
        return ResponseTokenUsage::default();
    };
    token_usage_value(usage)
}

/// Read provider-neutral token fields from one usage object.
pub(crate) fn token_usage_value(usage: &Value) -> ResponseTokenUsage {
    if !usage.is_object() {
        return ResponseTokenUsage::default();
    }
    let input = ["input_tokens", "prompt_tokens"]
        .into_iter()
        .find_map(|field| usage.get(field).and_then(Value::as_u64))
        .unwrap_or_default();
    let output = ["output_tokens", "completion_tokens"]
        .into_iter()
        .find_map(|field| usage.get(field).and_then(Value::as_u64))
        .unwrap_or_default();
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| input.saturating_add(output));
    ResponseTokenUsage {
        reported: true,
        input,
        output,
        total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_tools_model::parse_model_rate_limits;
    use serde_json::json;

    fn documented_catalogue() -> ModelRateLimitCatalogue {
        parse_model_rate_limits(
            r#"
            <table>
              <tr><th>Large language models</th><th>ITPM limit</th><th>OTPM limit</th><th>QPH limit</th></tr>
              <tr><td>GPT-5.6 Sol</td><td>200,000</td><td>20,000</td><td>360,000</td></tr>
              <tr><td>Qwen3.5 122B A10B</td><td>1,000,000</td><td>100,000</td><td>360,000</td></tr>
              <tr><td>DeepSeek V4 Pro (0813)</td><td>200,000</td><td>4,000</td><td>7,200</td></tr>
            </table>
            "#,
        )
        .unwrap()
    }

    #[test]
    fn estimates_input_and_requested_output_tokens() {
        let request = json!({"model": "gpt", "input": "hello", "max_output_tokens": 50});
        let estimate = token_estimate("databricks-gpt-6-astra", &request);

        assert!(estimate.input > 0);
        assert_eq!(estimate.output, 50);
        assert_eq!(
            estimate.input.saturating_add(estimate.output),
            estimate.input + 50
        );
        assert_eq!(
            requested_output_tokens("databricks-claude-sonnet-4-6", &json!({})),
            1_000
        );
    }

    #[test]
    fn token_estimate_excludes_opaque_encrypted_and_image_content() {
        let visible = json!({
            "model": "gpt",
            "input": [{"type": "message", "content": "Keep this visible"}]
        });
        let opaque = json!({
            "model": "gpt",
            "input": [
                {"type": "message", "content": "Keep this visible"},
                {"type": "reasoning", "encrypted_content": "A".repeat(1_000_000), "signature": "B".repeat(100_000)},
                {"type": "input_image", "image_url": format!("data:image/png;base64,{}", "C".repeat(1_000_000))},
                {"type": "base64", "media_type": "image/png", "data": "D".repeat(1_000_000)}
            ]
        });

        let visible_tokens = token_estimate("databricks-gpt-6-astra", &visible).input;
        let opaque_tokens = token_estimate("databricks-gpt-6-astra", &opaque).input;

        assert!(opaque_tokens < visible_tokens + 100);
        assert!(opaque_tokens < 200);
    }

    #[test]
    fn token_window_reports_oldest_reservation_delay() {
        let now = Instant::now();
        let mut window = TokenWindow::default();
        window.reserve(1, now, 80);
        assert_eq!(window.delay(now, 20, 100, WINDOW), None);
        assert_eq!(window.delay(now, 21, 100, WINDOW), Some(WINDOW));
        window.reconcile(1, 20);
        assert_eq!(window.reserved_tokens, 20);
        assert_eq!(window.delay(now, 80, 100, WINDOW), None);
    }

    #[test]
    fn calibration_adjusts_after_consistent_actual_usage() {
        let mut calibration = InputCalibration::default();
        calibration.observe(100, 80);
        calibration.observe(100, 80);
        assert_eq!(calibration.factor(), 1.0);
        calibration.observe(100, 80);
        assert!((calibration.factor() - 0.8).abs() < f64::EPSILON);
        assert_eq!(calibration.apply(100), 80);

        let mut calibration = InputCalibration::default();
        for _ in 0..3 {
            calibration.observe(100, 125);
        }
        assert!((calibration.factor() - 1.25).abs() < f64::EPSILON);
        assert_eq!(calibration.apply(100), 125);
    }

    #[tokio::test]
    async fn reported_usage_reconciles_input_and_output_reservations() {
        let queue = Arc::new(TokenQueue::default());
        let acquisition = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 80,
                output: 70,
            },
            TokenLimits {
                input: Some(InputTokenLimits::full(100)),
                output: Some(100),
            },
            RateLimitMode::On,
            WINDOW,
        )
        .await
        .unwrap();

        acquisition
            .reconcile(ResponseTokenUsage {
                reported: true,
                input: 30,
                output: 20,
                total: 50,
            })
            .await;

        let state = queue.state.lock().await;
        assert_eq!(state.input.reserved_tokens, 30);
        assert_eq!(state.output.reserved_tokens, 20);
    }

    #[tokio::test]
    async fn reconciliation_wakes_requests_waiting_for_capacity() {
        let queue = Arc::new(TokenQueue::default());
        let limits = TokenLimits {
            input: Some(InputTokenLimits::full(100)),
            output: None,
        };
        let acquisition = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 100,
                output: 0,
            },
            limits,
            RateLimitMode::On,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let waiting_queue = Arc::clone(&queue);
        let mut waiting = tokio::spawn(async move {
            reserve(
                waiting_queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                RateLimitMode::On,
                Duration::from_secs(1),
            )
            .await
            .unwrap()
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        acquisition
            .reconcile(ResponseTokenUsage {
                reported: true,
                input: 1,
                output: 0,
                total: 1,
            })
            .await;

        tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn oversized_input_is_rejected_without_a_clamped_reservation() {
        let queue = Arc::new(TokenQueue::default());
        let error = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 101,
                output: 0,
            },
            TokenLimits {
                input: Some(InputTokenLimits::full(100)),
                output: None,
            },
            RateLimitMode::On,
            WINDOW,
        )
        .await
        .unwrap_err();

        assert_eq!(error.estimated_input_tokens, 101);
        assert_eq!(error.input_limit, 100);
        assert_eq!(queue.state.lock().await.input.reserved_tokens, 0);
    }

    #[tokio::test]
    async fn cancelled_waiter_releases_fifo_admission() {
        let queue = Arc::new(TokenQueue::default());
        let limits = TokenLimits {
            input: Some(InputTokenLimits::full(100)),
            output: None,
        };
        let first = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 100,
                output: 0,
            },
            limits,
            RateLimitMode::On,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let waiting_queue = Arc::clone(&queue);
        let waiting = tokio::spawn(async move {
            reserve(
                waiting_queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                RateLimitMode::On,
                Duration::from_secs(1),
            )
            .await
        });
        tokio::task::yield_now().await;
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        assert_eq!(queue.queue_depth.load(Ordering::Relaxed), 0);
        first.release().await;

        tokio::time::timeout(
            Duration::from_millis(100),
            reserve(
                queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                RateLimitMode::On,
                Duration::from_secs(1),
            ),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn admission_is_fifo_for_each_workspace_model_queue() {
        let queue = Arc::new(TokenQueue::default());
        let limits = TokenLimits {
            input: Some(InputTokenLimits::full(100)),
            output: None,
        };
        let acquisition = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 100,
                output: 0,
            },
            limits,
            RateLimitMode::On,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let (completed, mut order) = tokio::sync::mpsc::unbounded_channel();
        let first_queue = Arc::clone(&queue);
        let first_completed = completed.clone();
        let first = tokio::spawn(async move {
            reserve(
                first_queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                RateLimitMode::On,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
            first_completed.send(1).unwrap();
        });
        tokio::task::yield_now().await;
        let second_queue = Arc::clone(&queue);
        let second = tokio::spawn(async move {
            reserve(
                second_queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                RateLimitMode::On,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
            completed.send(2).unwrap();
        });
        tokio::task::yield_now().await;
        acquisition
            .reconcile(ResponseTokenUsage {
                reported: true,
                input: 1,
                output: 0,
                total: 1,
            })
            .await;

        assert_eq!(order.recv().await, Some(1));
        assert_eq!(order.recv().await, Some(2));
        first.await.unwrap();
        second.await.unwrap();
    }

    #[test]
    fn published_limits_are_model_specific_and_skip_embeddings() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::On,
                documented_limits: documented_catalogue(),
            },
        );
        assert_eq!(
            throttle.limits("databricks-gpt-5-6-sol", Some(ModelClass::ChatBalanced)),
            TokenLimits {
                input: Some(InputTokenLimits::full(200_000)),
                output: Some(20_000),
            }
        );
        assert_eq!(
            throttle.limits("qwen3.5-122b-a10b", Some(ModelClass::ChatBalanced)),
            TokenLimits {
                input: Some(InputTokenLimits::full(1_000_000)),
                output: Some(100_000),
            }
        );
        assert_eq!(
            throttle.limits(
                "databricks-deepseek-v4-pro-0813",
                Some(ModelClass::ChatThinking)
            ),
            TokenLimits {
                input: Some(InputTokenLimits::full(200_000)),
                output: Some(4_000),
            }
        );
        assert_eq!(
            throttle.limits("databricks-gte-large-en", Some(ModelClass::Embedding)),
            TokenLimits::default()
        );
    }

    #[test]
    fn provisioned_throughput_disables_tpm_limits() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(1),
                output_tokens_per_minute: NonZeroU64::new(1),
                provisioned_throughput: true,
                mode: RateLimitMode::On,
                documented_limits: documented_catalogue(),
            },
        );

        assert_eq!(
            throttle.limits("databricks-gpt-5-6-sol", Some(ModelClass::ChatBalanced)),
            TokenLimits::default()
        );
    }

    #[tokio::test]
    async fn explicit_modes_never_enter_adaptive_state() {
        for mode in [RateLimitMode::On, RateLimitMode::Off] {
            let throttle = RequestThrottle::new(
                "workspace",
                ThrottleConfig {
                    input_tokens_per_minute: NonZeroU64::new(100),
                    output_tokens_per_minute: NonZeroU64::new(10),
                    provisioned_throughput: false,
                    mode,
                    documented_limits: Default::default(),
                },
            );
            assert_eq!(
                throttle
                    .activate_from_message("model", None, Some("Exceeded workspace input tokens"),)
                    .await,
                AutoActivation::Ignored
            );
            assert_eq!(throttle.counters().await.auto_active_keys, 0);
        }
    }

    #[tokio::test]
    async fn auto_mode_activates_only_after_matching_input_token_429() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::Auto,
                documented_limits: documented_catalogue(),
            },
        );
        let queue = throttle.queue("databricks-gpt-5-6-sol").await;
        assert!(!throttle.enabled(&queue).await);
        assert_eq!(
            throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some(ModelClass::ChatBalanced),
                    Some("Exceeded workspace output tokens per minute"),
                )
                .await,
            AutoActivation::Ignored
        );
        assert!(matches!(
            throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some(ModelClass::ChatBalanced),
                    Some("REQUEST_LIMIT_EXCEEDED: EXCEEDED WORKSPACE INPUT TOKENS per minute"),
                )
                .await,
            AutoActivation::Transition(AutoTransition {
                kind: AutoTransitionKind::Activated,
                penalty_basis_points: 1_000,
                ..
            })
        ));
        assert!(throttle.enabled(&queue).await);
        assert!(matches!(
            throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some(ModelClass::ChatBalanced),
                    Some("Exceeded workspace input tokens"),
                )
                .await,
            AutoActivation::Transition(AutoTransition {
                kind: AutoTransitionKind::Tightened,
                penalty_basis_points: 2_000,
                ..
            })
        ));
        let other = throttle.queue("databricks-gpt-6-astra").await;
        assert!(!throttle.enabled(&other).await);
    }

    #[tokio::test]
    async fn auto_mode_keeps_unknown_limits_inactive() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );

        assert_eq!(
            throttle
                .activate_from_message(
                    "unknown-model",
                    None,
                    Some("Exceeded workspace input tokens"),
                )
                .await,
            AutoActivation::Unavailable
        );
        assert_eq!(throttle.counters().await.auto_active_keys, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn full_recovery_deactivates_queueing_and_updates_health_counters() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        )
        .with_auto_recovery_policy(AutoRecoveryPolicy {
            recovery_basis_points: 5_000,
            initial_hold: Duration::from_secs(10),
            recovery_interval: Duration::from_secs(5),
            clean_successes: 1,
            ..AutoRecoveryPolicy::default()
        });
        assert!(matches!(
            throttle
                .activate_from_message("model", None, Some("Exceeded workspace input tokens"),)
                .await,
            AutoActivation::Transition(_)
        ));

        tokio::time::advance(Duration::from_secs(10)).await;
        let deactivated = throttle
            .record_success("model", None)
            .await
            .expect("full recovery deactivates automatic admission");
        assert_eq!(deactivated.kind, AutoTransitionKind::Deactivated);
        let counters = throttle.counters().await;
        assert_eq!(counters.automatic_relaxations, 0);
        assert_eq!(counters.automatic_deactivations, 1);
        assert_eq!(counters.auto_active_keys, 0);
        let queue = throttle.queue("model").await;
        assert!(!throttle.enabled(&queue).await);
    }

    #[tokio::test]
    async fn adaptive_budget_preserves_the_complete_request_ceiling() {
        let queue = Arc::new(TokenQueue::default());
        queue.state.lock().await.adaptive.record_input_429(
            Instant::now(),
            100,
            AutoRecoveryPolicy::default(),
        );
        let limits = TokenLimits {
            input: Some(InputTokenLimits::full(100)),
            output: None,
        };

        let acquisition = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 80,
                output: 0,
            },
            limits,
            RateLimitMode::Auto,
            Duration::from_secs(1),
        )
        .await
        .expect("a request within the ceiling can occupy an empty window");

        assert_eq!(acquisition.input_limit, Some(100));
        assert_eq!(acquisition.input_window_budget, Some(90));
        assert_eq!(acquisition.reserved_input_tokens, 80);
    }

    #[tokio::test]
    async fn capacity_snapshot_uses_the_actual_model_queue() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: NonZeroU64::new(100),
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::Auto,
                documented_limits: Default::default(),
            },
        );
        throttle
            .activate_from_message(
                "resolved-model",
                None,
                Some("Exceeded workspace input tokens"),
            )
            .await;
        throttle
            .acquire(
                "resolved-model",
                None,
                TokenEstimate {
                    input: 20,
                    output: 0,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            throttle.capacity_snapshots().await,
            [ThrottleModelSnapshot {
                model: "resolved-model".to_owned(),
                active: true,
                input_limit: Some(100),
                effective_input_budget: Some(90),
                input_window_used: Some(20),
                penalty_basis_points: 1_000,
                queue_depth: 0,
            }]
        );
    }

    #[test]
    fn reads_provider_token_usage_shapes() {
        assert_eq!(
            response_token_usage(
                &json!({"usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}})
            ),
            ResponseTokenUsage {
                reported: true,
                input: 10,
                output: 4,
                total: 14,
            }
        );
        assert_eq!(
            response_token_usage(&json!({"usage": {"input_tokens": 7, "output_tokens": 3}})),
            ResponseTokenUsage {
                reported: true,
                input: 7,
                output: 3,
                total: 10,
            }
        );
    }
}
