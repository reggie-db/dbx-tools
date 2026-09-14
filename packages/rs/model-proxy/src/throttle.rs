//! Optional per-workspace, per-model token reservation queue.

use std::{
    collections::{HashMap, VecDeque},
    num::NonZeroU64,
    sync::Arc,
    time::Duration,
};

use dbx_tools_model::{ModelClass, ModelRateLimitCatalogue};
use serde_json::Value;
use tokenx_rs::estimate_token_count;
use tokio::{sync::Mutex, time::Instant};

const WINDOW: Duration = Duration::from_secs(60);
const CLAUDE_SONNET_4_DEFAULT_OUTPUT_TOKENS: u64 = 1_000;

#[derive(Clone, Debug)]
pub(crate) struct RequestThrottle {
    workspace: Arc<str>,
    input_tokens_per_minute: Option<NonZeroU64>,
    output_tokens_per_minute: Option<NonZeroU64>,
    provisioned_throughput: bool,
    documented_limits: ModelRateLimitCatalogue,
    queues: Arc<Mutex<HashMap<ThrottleKey, Arc<Mutex<WindowState>>>>>,
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
    /// Cached Databricks pay-per-token limits.
    pub(crate) documented_limits: ModelRateLimitCatalogue,
}

/// Token estimate and time spent waiting for a local reservation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ThrottleAcquisition {
    /// Time spent waiting for capacity in the local queue.
    pub(crate) wait: Duration,
    /// Estimated input tokens reserved for the request.
    pub(crate) estimated_input_tokens: u64,
    /// Requested or documented default output tokens reserved for the request.
    pub(crate) reserved_output_tokens: u64,
    /// Estimated input plus reserved output tokens.
    pub(crate) estimated_tokens: u64,
}

/// Token usage reported by a completed upstream response.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ResponseTokenUsage {
    /// Input or prompt tokens consumed.
    pub(crate) input: u64,
    /// Output or completion tokens consumed.
    pub(crate) output: u64,
    /// Total tokens consumed.
    pub(crate) total: u64,
}

impl RequestThrottle {
    pub(crate) fn new(workspace: &str, config: ThrottleConfig) -> Self {
        Self {
            workspace: Arc::from(workspace),
            input_tokens_per_minute: config.input_tokens_per_minute,
            output_tokens_per_minute: config.output_tokens_per_minute,
            provisioned_throughput: config.provisioned_throughput,
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
        let limits = self.limits(model, model_class);
        if !limits.enabled() {
            return ThrottleAcquisition {
                wait: Duration::ZERO,
                estimated_input_tokens: estimate.input,
                reserved_output_tokens: estimate.output,
                estimated_tokens: estimate.total(),
            };
        }
        let key = ThrottleKey {
            workspace: self.workspace.clone(),
            model: Arc::from(model),
        };
        let queue = {
            let mut queues = self.queues.lock().await;
            queues.entry(key).or_default().clone()
        };
        let wait = reserve(queue, estimate, limits, WINDOW).await;
        ThrottleAcquisition {
            wait,
            estimated_input_tokens: estimate.input,
            reserved_output_tokens: estimate.output,
            estimated_tokens: estimate.total(),
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
struct WindowState {
    input: TokenWindow,
    output: TokenWindow,
}

#[derive(Debug, Default)]
struct TokenWindow {
    reservations: VecDeque<(Instant, u64)>,
    reserved_tokens: u64,
}

impl TokenWindow {
    fn prune(&mut self, now: Instant, window: Duration) {
        while self
            .reservations
            .front()
            .is_some_and(|(reserved_at, _)| now.duration_since(*reserved_at) >= window)
        {
            let (_, tokens) = self
                .reservations
                .pop_front()
                .expect("front reservation exists");
            self.reserved_tokens = self.reserved_tokens.saturating_sub(tokens);
        }
    }

    fn delay(&self, now: Instant, tokens: u64, limit: u64, window: Duration) -> Option<Duration> {
        if self.reserved_tokens.saturating_add(tokens) <= limit {
            return None;
        }
        self.reservations
            .front()
            .map(|(reserved_at, _)| window.saturating_sub(now.duration_since(*reserved_at)))
    }

    fn reserve(&mut self, now: Instant, tokens: u64) {
        self.reservations.push_back((now, tokens));
        self.reserved_tokens = self.reserved_tokens.saturating_add(tokens);
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TokenEstimate {
    input: u64,
    output: u64,
}

impl TokenEstimate {
    fn total(self) -> u64 {
        self.input.saturating_add(self.output)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TokenLimits {
    input: Option<u64>,
    output: Option<u64>,
}

impl TokenLimits {
    fn enabled(self) -> bool {
        self.input.is_some() || self.output.is_some()
    }
}

async fn reserve(
    queue: Arc<Mutex<WindowState>>,
    estimate: TokenEstimate,
    limits: TokenLimits,
    window: Duration,
) -> Duration {
    let started = Instant::now();
    let mut state = queue.lock().await;
    loop {
        let now = Instant::now();
        state.input.prune(now, window);
        state.output.prune(now, window);
        let input_tokens = limits
            .input
            .map(|limit| estimate.input.min(limit))
            .unwrap_or_default();
        let output_tokens = limits
            .output
            .map(|limit| estimate.output.min(limit))
            .unwrap_or_default();
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
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
            continue;
        }
        if limits.input.is_some() {
            state.input.reserve(now, input_tokens);
        }
        if limits.output.is_some() {
            state.output.reserve(now, output_tokens);
        }
        return started.elapsed();
    }
}

/// Estimate input tokens with tokenx and reserve caller-selected output capacity.
fn token_estimate(model: &str, request: &Value) -> TokenEstimate {
    let input = serde_json::to_string(request)
        .map(|body| estimate_token_count(&body) as u64)
        .unwrap_or_default()
        .max(1);
    TokenEstimate {
        input,
        output: requested_output_tokens(model, request),
    }
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
        assert_eq!(estimate.total(), estimate.input + 50);
        assert_eq!(
            requested_output_tokens("databricks-claude-sonnet-4-6", &json!({})),
            1_000
        );
    }

    #[test]
    fn token_window_reports_oldest_reservation_delay() {
        let now = Instant::now();
        let mut window = TokenWindow::default();
        window.reserve(now, 80);
        assert_eq!(window.delay(now, 20, 100, WINDOW), None);
        assert_eq!(window.delay(now, 21, 100, WINDOW), Some(WINDOW));
    }

    #[test]
    fn published_limits_are_model_specific_and_skip_embeddings() {
        let throttle = RequestThrottle::new(
            "workspace",
            ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
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
                documented_limits: documented_catalogue(),
            },
        );

        assert_eq!(
            throttle.limits("databricks-gpt-5-6-sol", Some(ModelClass::ChatBalanced)),
            TokenLimits::default()
        );
    }

    #[test]
    fn reads_provider_token_usage_shapes() {
        assert_eq!(
            response_token_usage(
                &json!({"usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}})
            ),
            ResponseTokenUsage {
                input: 10,
                output: 4,
                total: 14,
            }
        );
        assert_eq!(
            response_token_usage(&json!({"usage": {"input_tokens": 7, "output_tokens": 3}})),
            ResponseTokenUsage {
                input: 7,
                output: 3,
                total: 10,
            }
        );
    }
}
