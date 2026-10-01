//! Process-local, profile-and-model keyed rate-limit recovery.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::http::{header, HeaderMap};
use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use clap::ValueEnum;
use serde_json::Value;
use tokio::{
    sync::{futures::OwnedNotified, Mutex, Notify},
    time::Instant,
};

/// Model selection behavior when rate-limit recovery would otherwise wait.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub(crate) enum ModelFallbackMode {
    /// Return rate-limit recovery to the originally resolved model.
    Off,
    /// Try compatible lower versions from the same model family.
    #[default]
    SameFamily,
}

/// Policy for selecting another model before a long rate-limit wait.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModelFallbackPolicy {
    pub(crate) mode: ModelFallbackMode,
    pub(crate) max_steps: usize,
    pub(crate) threshold: Duration,
}

impl Default for ModelFallbackPolicy {
    fn default() -> Self {
        Self {
            mode: ModelFallbackMode::SameFamily,
            max_steps: 5,
            threshold: Duration::from_secs(10),
        }
    }
}

impl ModelFallbackPolicy {
    pub(crate) fn enabled(self) -> bool {
        self.mode == ModelFallbackMode::SameFamily && self.max_steps > 0
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RateLimitPolicy {
    pub(crate) max_retries: u32,
    pub(crate) initial_delay: Duration,
    pub(crate) max_delay: Duration,
    pub(crate) max_wait: Duration,
}

impl RateLimitPolicy {
    pub(crate) fn backoff(self) -> ExponentialBackoff {
        ExponentialBuilder::default()
            .with_min_delay(self.initial_delay)
            .with_max_delay(self.max_delay)
            .with_max_times(self.max_retries as usize)
            .with_jitter()
            .build()
    }

    /// Split a bounded recovery horizon across the remaining retry delays.
    pub(crate) fn incremental_delay(
        self,
        upper_bound: Duration,
        remaining_delays: u32,
    ) -> Duration {
        if upper_bound.is_zero() {
            return Duration::ZERO;
        }
        upper_bound
            .div_f64(f64::from(remaining_delays.max(1)))
            .max(self.initial_delay)
            .min(self.max_delay)
            .min(upper_bound)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RateLimitGate {
    policy: RateLimitPolicy,
    gates: Arc<Mutex<HashMap<RateLimitKey, Arc<KeyGate>>>>,
}

impl RateLimitGate {
    pub(crate) fn new(policy: RateLimitPolicy) -> Self {
        Self {
            policy,
            gates: Arc::default(),
        }
    }

    pub(crate) fn policy(&self) -> RateLimitPolicy {
        self.policy
    }

    #[cfg(test)]
    pub(crate) async fn acquire(
        &self,
        host: &str,
        principal: &str,
        model: &str,
    ) -> RateLimitPermit {
        self.acquire_preferred(host, principal, &[model]).await.1
    }

    /// Acquire the highest preferred model whose cooldown permits a request.
    pub(crate) async fn acquire_preferred(
        &self,
        host: &str,
        principal: &str,
        models: &[&str],
    ) -> (usize, RateLimitPermit) {
        assert!(!models.is_empty(), "preferred model list must not be empty");
        loop {
            let mut fallback_wait: Option<(Instant, OwnedNotified)> = None;
            for (index, model) in models.iter().enumerate() {
                let gate = self.gate(host, principal, model).await;
                let notified = Arc::clone(&gate.notify).notified_owned();
                let mut state = gate.state.lock().await;
                let now = Instant::now();
                match state.blocked_until {
                    Some(until) if until > now && state.fallback_eligible => {
                        if fallback_wait
                            .as_ref()
                            .is_none_or(|(current, _)| until < *current)
                        {
                            fallback_wait = Some((until, notified));
                        }
                    }
                    Some(until) if until > now => {
                        let delay = until - now;
                        drop(state);
                        tokio::time::sleep(delay).await;
                        break;
                    }
                    Some(_) if state.probe_in_flight && state.fallback_eligible => {
                        fallback_wait.get_or_insert((now, notified));
                    }
                    Some(_) if state.probe_in_flight => {
                        drop(state);
                        notified.await;
                        break;
                    }
                    Some(_) => {
                        state.probe_in_flight = true;
                        drop(state);
                        return (
                            index,
                            RateLimitPermit {
                                gate: Arc::clone(&gate),
                                probe: true,
                            },
                        );
                    }
                    None => {
                        drop(state);
                        return (
                            index,
                            RateLimitPermit {
                                gate: Arc::clone(&gate),
                                probe: false,
                            },
                        );
                    }
                }
                if index + 1 == models.len() {
                    if let Some((until, notified)) = fallback_wait.take() {
                        let now = Instant::now();
                        if until > now {
                            tokio::time::sleep_until(until).await;
                        } else {
                            notified.await;
                        }
                    }
                }
            }
        }
    }

    pub(crate) async fn rejected(&self, permit: &RateLimitPermit, delay: Duration) {
        self.reject(permit, delay, false).await;
    }

    /// Mark a model unavailable while lower fallback candidates remain eligible.
    pub(crate) async fn rejected_for_fallback(&self, permit: &RateLimitPermit, delay: Duration) {
        self.reject(permit, delay, true).await;
    }

    async fn reject(&self, permit: &RateLimitPermit, delay: Duration, fallback_eligible: bool) {
        let mut state = permit.gate.state.lock().await;
        let until = Instant::now() + delay;
        state.blocked_until = Some(
            state
                .blocked_until
                .map_or(until, |current| current.max(until)),
        );
        state.fallback_eligible = fallback_eligible;
        if permit.probe {
            state.probe_in_flight = false;
        }
        drop(state);
        permit.gate.notify.notify_waiters();
    }

    pub(crate) async fn completed(&self, permit: &RateLimitPermit) {
        if !permit.probe {
            return;
        }
        let mut state = permit.gate.state.lock().await;
        state.blocked_until = None;
        state.probe_in_flight = false;
        state.fallback_eligible = false;
        drop(state);
        permit.gate.notify.notify_waiters();
    }

    /// Release an unfinished recovery probe without changing its cooldown.
    pub(crate) async fn cancelled(&self, permit: &RateLimitPermit) {
        if !permit.probe {
            return;
        }
        let mut state = permit.gate.state.lock().await;
        state.probe_in_flight = false;
        drop(state);
        permit.gate.notify.notify_waiters();
    }

    async fn gate(&self, host: &str, principal: &str, model: &str) -> Arc<KeyGate> {
        let mut gates = self.gates.lock().await;
        gates
            .entry(RateLimitKey {
                host: Arc::from(host),
                principal: Arc::from(principal),
                model: Arc::from(model),
            })
            .or_default()
            .clone()
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RateLimitKey {
    host: Arc<str>,
    principal: Arc<str>,
    model: Arc<str>,
}

#[derive(Debug, Default)]
struct KeyGate {
    state: Mutex<GateState>,
    notify: Arc<Notify>,
}

#[derive(Debug, Default)]
struct GateState {
    blocked_until: Option<Instant>,
    probe_in_flight: bool,
    fallback_eligible: bool,
}

#[derive(Debug)]
pub(crate) struct RateLimitPermit {
    gate: Arc<KeyGate>,
    probe: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RateLimitDetails {
    /// Human-readable Databricks rejection message.
    pub(crate) message: Option<String>,
    /// Suggested retry delay from the JSON body.
    pub(crate) retry_after: Option<Duration>,
    /// Limit category such as input tokens per minute.
    pub(crate) limit_type: Option<String>,
    /// Configured limit for the rejected category.
    pub(crate) limit: Option<u64>,
    /// Current usage reported for the rejected category.
    pub(crate) current: Option<u64>,
}

/// Parse the documented Databricks Foundation Model API 429 error fields.
pub(crate) fn rate_limit_details(body: &[u8]) -> RateLimitDetails {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return RateLimitDetails::default();
    };
    let error = value.get("error").unwrap_or(&value);
    let message = error
        .get("message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_owned);
    let retry_after = error
        .get("retry_after")
        .or_else(|| value.get("retry_after"))
        .and_then(retry_after_value);
    let limit_type = error
        .get("limit_type")
        .or_else(|| value.get("limit_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|limit_type| !limit_type.is_empty())
        .map(str::to_owned);
    let limit = error
        .get("limit")
        .or_else(|| value.get("limit"))
        .and_then(integer_value);
    let current = error
        .get("current")
        .or_else(|| value.get("current"))
        .and_then(integer_value);
    RateLimitDetails {
        message,
        retry_after,
        limit_type,
        limit,
        current,
    }
}

/// Parse an HTTP Retry-After header as seconds or an HTTP date.
pub(crate) fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(header::RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = httpdate::parse_http_date(value).ok()?;
    Some(
        retry_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

/// Resolve server-provided retry timing with the HTTP header taking precedence.
pub(crate) fn server_retry_after(
    headers: &HeaderMap,
    details: &RateLimitDetails,
) -> Option<(Duration, &'static str)> {
    retry_after(headers)
        .map(|delay| (delay, "header"))
        .or_else(|| details.retry_after.map(|delay| (delay, "body")))
}

fn retry_after_value(value: &Value) -> Option<Duration> {
    integer_value(value).map(Duration::from_secs)
}

fn integer_value(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().replace(',', "").parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_fallback_defaults_limit_latency_and_depth() {
        assert_eq!(
            ModelFallbackPolicy::default(),
            ModelFallbackPolicy {
                mode: ModelFallbackMode::SameFamily,
                max_steps: 5,
                threshold: Duration::from_secs(10),
            }
        );
    }

    #[test]
    fn parses_retry_after_seconds_and_dates() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RETRY_AFTER, "12".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(12)));

        headers.insert(
            header::RETRY_AFTER,
            httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(30))
                .parse()
                .unwrap(),
        );
        assert!(retry_after(&headers).is_some_and(|delay| delay <= Duration::from_secs(30)));
    }

    #[test]
    fn parses_databricks_rate_limit_message_and_retry_delay() {
        let details =
            rate_limit_details(
                br#"{"error":{"message":"Rate limit exceeded","retry_after":15,"limit_type":"input_tokens_per_minute","limit":200000,"current":200150}}"#,
            );

        assert_eq!(details.message.as_deref(), Some("Rate limit exceeded"));
        assert_eq!(details.retry_after, Some(Duration::from_secs(15)));
        assert_eq!(
            details.limit_type.as_deref(),
            Some("input_tokens_per_minute")
        );
        assert_eq!(details.limit, Some(200_000));
        assert_eq!(details.current, Some(200_150));
        assert_eq!(
            rate_limit_details(br#"{"message":"  quota exhausted  ","retry_after":"7"}"#),
            RateLimitDetails {
                message: Some("quota exhausted".to_owned()),
                retry_after: Some(Duration::from_secs(7)),
                ..Default::default()
            }
        );
        assert_eq!(rate_limit_details(b"not json"), RateLimitDetails::default());

        let mut headers = HeaderMap::new();
        headers.insert(header::RETRY_AFTER, "3".parse().unwrap());
        assert_eq!(
            server_retry_after(&headers, &details),
            Some((Duration::from_secs(3), "header"))
        );
        headers.clear();
        assert_eq!(
            server_retry_after(&headers, &details),
            Some((Duration::from_secs(15), "body"))
        );
    }

    #[test]
    fn stages_long_recovery_horizons_across_remaining_delays() {
        let policy = RateLimitPolicy {
            max_retries: 5,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            max_wait: Duration::from_secs(60),
        };

        assert_eq!(
            policy.incremental_delay(Duration::from_secs(43), 5),
            Duration::from_secs_f64(8.6)
        );
        assert_eq!(
            policy.incremental_delay(Duration::from_secs(3), 5),
            Duration::from_secs(1)
        );
        assert_eq!(
            policy.incremental_delay(Duration::from_millis(500), 5),
            Duration::from_millis(500)
        );
        assert_eq!(
            policy.incremental_delay(Duration::from_secs(600), 2),
            Duration::from_secs(60)
        );
        assert_eq!(policy.incremental_delay(Duration::ZERO, 5), Duration::ZERO);
    }

    #[tokio::test]
    async fn blocks_a_key_until_its_shared_cooldown_expires() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let permit = gate.acquire("host", "principal", "model").await;
        gate.rejected(&permit, Duration::from_millis(25)).await;
        let started = Instant::now();

        let probe = gate.acquire("host", "principal", "model").await;

        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(probe.probe);
        let waiting_gate = gate.clone();
        let mut waiting =
            tokio::spawn(async move { waiting_gate.acquire("host", "principal", "model").await });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        gate.completed(&probe).await;
        assert!(!waiting.await.unwrap().probe);
    }

    #[tokio::test]
    async fn preferred_models_fall_back_then_probe_the_primary_after_cooldown() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let models = ["primary", "fallback"];
        let (primary_index, primary) = gate.acquire_preferred("host", "principal", &models).await;
        assert_eq!(primary_index, 0);
        gate.rejected_for_fallback(&primary, Duration::from_millis(25))
            .await;

        let (fallback_index, fallback) = gate.acquire_preferred("host", "principal", &models).await;
        assert_eq!(fallback_index, 1);
        assert!(!fallback.probe);

        tokio::time::sleep(Duration::from_millis(30)).await;
        let (probe_index, probe) = gate.acquire_preferred("host", "principal", &models).await;
        assert_eq!(probe_index, 0);
        assert!(probe.probe);
        gate.completed(&probe).await;

        let (recovered_index, recovered) =
            gate.acquire_preferred("host", "principal", &models).await;
        assert_eq!(recovered_index, 0);
        assert!(!recovered.probe);
    }

    #[tokio::test]
    async fn keeps_other_host_principal_model_keys_independent() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let permit = gate.acquire("host", "principal-a", "model").await;
        gate.rejected(&permit, Duration::from_secs(1)).await;

        let other = gate.acquire("host", "principal-b", "model").await;

        assert!(!other.probe);
    }
}
