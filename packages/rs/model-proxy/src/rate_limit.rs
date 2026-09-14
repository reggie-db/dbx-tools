//! Process-local, profile-and-model keyed rate-limit recovery.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::http::{header, HeaderMap};
use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
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
