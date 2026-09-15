//! Optional per-workspace, per-model token reservation queue.

use std::{
    collections::{HashMap, VecDeque},
    num::NonZeroU64,
    sync::{
        atomic::{AtomicBool, Ordering},
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
    reservation: Option<ThrottleReservation>,
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
        }
    }

    pub(crate) async fn acquire(
        &self,
        model: &str,
        model_class: Option<ModelClass>,
        request: &Value,
    ) -> ThrottleAcquisition {
        let estimate = token_estimate(model, request);
        let queue = self.queue(model).await;
        let limits = if self.enabled(&queue) {
            self.limits(model, model_class)
        } else {
            TokenLimits::default()
        };
        let (wait, reservation, adjusted_input, estimate_factor) =
            reserve(queue, estimate, limits, WINDOW).await;
        ThrottleAcquisition {
            wait,
            estimated_input_tokens: adjusted_input,
            raw_estimated_input_tokens: estimate.input,
            estimate_factor,
            reserved_output_tokens: estimate.output,
            estimated_tokens: adjusted_input.saturating_add(estimate.output),
            reservation: Some(reservation),
        }
    }

    /// Activate automatic TPM admission after a matching Databricks 429.
    pub(crate) async fn activate_from_message(&self, model: &str, message: Option<&str>) -> bool {
        if self.provisioned_throughput
            || self.mode != RateLimitMode::Auto
            || !message.is_some_and(|message| {
                message
                    .to_ascii_lowercase()
                    .contains("exceeded workspace input tokens")
            })
        {
            return false;
        }
        !self.queue(model).await.active.swap(true, Ordering::AcqRel)
    }

    async fn queue(&self, model: &str) -> Arc<TokenQueue> {
        let key = ThrottleKey {
            workspace: self.workspace.clone(),
            model: Arc::from(model),
        };
        let mut queues = self.queues.lock().await;
        queues.entry(key).or_default().clone()
    }

    fn enabled(&self, queue: &TokenQueue) -> bool {
        if self.provisioned_throughput {
            return false;
        }
        match self.mode {
            RateLimitMode::Auto => queue.active.load(Ordering::Acquire),
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
                .or_else(|| documented.and_then(|limits| limits.input_tokens_per_minute)),
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
struct TokenQueue {
    /// Tokio mutex acquisition order provides FIFO admission for this key.
    admission: Mutex<()>,
    active: AtomicBool,
    state: Mutex<WindowState>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct WindowState {
    next_id: u64,
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
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TokenEstimate {
    input: u64,
    output: u64,
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
    input: Option<u64>,
    output: Option<u64>,
}

async fn reserve(
    queue: Arc<TokenQueue>,
    estimate: TokenEstimate,
    limits: TokenLimits,
    window: Duration,
) -> (Duration, ThrottleReservation, u64, f64) {
    let started = Instant::now();
    let _admission = queue.admission.lock().await;
    let output_tokens = limits
        .output
        .map(|limit| estimate.output.min(limit))
        .unwrap_or_default();
    loop {
        let notified = queue.notify.notified();
        let delay = {
            let now = Instant::now();
            let mut state = queue.state.lock().await;
            let estimate_factor = state.calibration.factor();
            let adjusted_input = state.calibration.apply(estimate.input);
            let input_tokens = limits
                .input
                .map(|limit| adjusted_input.min(limit))
                .unwrap_or_default();
            state.input.prune(now, window);
            state.output.prune(now, window);
            let delay = [
                limits
                    .input
                    .and_then(|limit| state.input.delay(now, input_tokens, limit, window)),
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
                return (
                    started.elapsed(),
                    ThrottleReservation {
                        queue: Arc::clone(&queue),
                        id,
                        raw_estimated_input: estimate.input,
                    },
                    adjusted_input,
                    estimate_factor,
                );
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
        let (_, reservation, _, _) = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 80,
                output: 70,
            },
            TokenLimits {
                input: Some(100),
                output: Some(100),
            },
            WINDOW,
        )
        .await;
        let acquisition = ThrottleAcquisition {
            wait: Duration::ZERO,
            estimated_input_tokens: 80,
            raw_estimated_input_tokens: 80,
            estimate_factor: 1.0,
            reserved_output_tokens: 70,
            estimated_tokens: 150,
            reservation: Some(reservation),
        };

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
            input: Some(100),
            output: None,
        };
        let (_, reservation, _, _) = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 100,
                output: 0,
            },
            limits,
            Duration::from_secs(1),
        )
        .await;
        let waiting_queue = Arc::clone(&queue);
        let mut waiting = tokio::spawn(async move {
            reserve(
                waiting_queue,
                TokenEstimate {
                    input: 1,
                    output: 0,
                },
                limits,
                Duration::from_secs(1),
            )
            .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        let acquisition = ThrottleAcquisition {
            wait: Duration::ZERO,
            estimated_input_tokens: 100,
            raw_estimated_input_tokens: 100,
            estimate_factor: 1.0,
            reserved_output_tokens: 0,
            estimated_tokens: 100,
            reservation: Some(reservation),
        };

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
    async fn admission_is_fifo_for_each_workspace_model_queue() {
        let queue = Arc::new(TokenQueue::default());
        let limits = TokenLimits {
            input: Some(100),
            output: None,
        };
        let (_, reservation, _, _) = reserve(
            Arc::clone(&queue),
            TokenEstimate {
                input: 100,
                output: 0,
            },
            limits,
            Duration::from_secs(1),
        )
        .await;
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
                Duration::from_secs(1),
            )
            .await;
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
                Duration::from_secs(1),
            )
            .await;
            completed.send(2).unwrap();
        });
        tokio::task::yield_now().await;
        let acquisition = ThrottleAcquisition {
            wait: Duration::ZERO,
            estimated_input_tokens: 100,
            raw_estimated_input_tokens: 100,
            estimate_factor: 1.0,
            reserved_output_tokens: 0,
            estimated_tokens: 100,
            reservation: Some(reservation),
        };

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
                input: Some(200_000),
                output: Some(20_000),
            }
        );
        assert_eq!(
            throttle.limits("qwen3.5-122b-a10b", Some(ModelClass::ChatBalanced)),
            TokenLimits {
                input: Some(1_000_000),
                output: Some(100_000),
            }
        );
        assert_eq!(
            throttle.limits(
                "databricks-deepseek-v4-pro-0813",
                Some(ModelClass::ChatThinking)
            ),
            TokenLimits {
                input: Some(200_000),
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
        assert!(!throttle.enabled(&queue));
        assert!(
            !throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some("Exceeded workspace output tokens per minute")
                )
                .await
        );
        assert!(
            throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some("REQUEST_LIMIT_EXCEEDED: EXCEEDED WORKSPACE INPUT TOKENS per minute")
                )
                .await
        );
        assert!(throttle.enabled(&queue));
        assert!(
            !throttle
                .activate_from_message(
                    "databricks-gpt-5-6-sol",
                    Some("Exceeded workspace input tokens")
                )
                .await
        );
        let other = throttle.queue("databricks-gpt-6-astra").await;
        assert!(!throttle.enabled(&other));
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
