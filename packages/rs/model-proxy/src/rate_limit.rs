//! Process-local, profile-and-model keyed rate-limit recovery.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::http::{header, HeaderMap};
use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use serde_json::Value;
use tokio::{
    sync::{Mutex, Notify},
    time::Instant,
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct RateLimitPolicy {
    pub(crate) max_retries: u32,
    pub(crate) initial_delay: Duration,
    pub(crate) max_delay: Duration,
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

    pub(crate) async fn acquire(
        &self,
        host: &str,
        principal: &str,
        model: &str,
    ) -> RateLimitPermit {
        let gate = {
            let mut gates = self.gates.lock().await;
            gates
                .entry(RateLimitKey {
                    host: Arc::from(host),
                    principal: Arc::from(principal),
                    model: Arc::from(model),
                })
                .or_default()
                .clone()
        };
        loop {
            let notified = gate.notify.notified();
            let mut state = gate.state.lock().await;
            let now = Instant::now();
            match state.blocked_until {
                Some(until) if until > now => {
                    let delay = until - now;
                    drop(state);
                    tokio::time::sleep(delay).await;
                }
                Some(_) if state.probe_in_flight => {
                    drop(state);
                    notified.await;
                }
                Some(_) => {
                    state.probe_in_flight = true;
                    drop(state);
                    return RateLimitPermit {
                        gate: Arc::clone(&gate),
                        probe: true,
                    };
                }
                None => {
                    drop(state);
                    return RateLimitPermit {
                        gate: Arc::clone(&gate),
                        probe: false,
                    };
                }
            }
        }
    }

    pub(crate) async fn rejected(&self, permit: &RateLimitPermit, delay: Duration) {
        let mut state = permit.gate.state.lock().await;
        let until = Instant::now() + delay;
        state.blocked_until = Some(
            state
                .blocked_until
                .map_or(until, |current| current.max(until)),
        );
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
        drop(state);
        permit.gate.notify.notify_waiters();
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
    notify: Notify,
}

#[derive(Debug, Default)]
struct GateState {
    blocked_until: Option<Instant>,
    probe_in_flight: bool,
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

    #[tokio::test]
    async fn blocks_a_key_until_its_shared_cooldown_expires() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
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
    async fn keeps_other_host_principal_model_keys_independent() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
        });
        let permit = gate.acquire("host", "principal-a", "model").await;
        gate.rejected(&permit, Duration::from_secs(1)).await;

        let other = gate.acquire("host", "principal-b", "model").await;

        assert!(!other.probe);
    }
}
