//! Process-local, profile-and-model keyed rate-limit recovery.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
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

const DEFAULT_GATE_CAPACITY: usize = 1_024;
const DEFAULT_GATE_IDLE_TTL: Duration = Duration::from_secs(60 * 60);

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
    counters: Arc<RateLimitControlCounters>,
    capacity: usize,
    idle_ttl: Duration,
}

impl RateLimitGate {
    pub(crate) fn new(policy: RateLimitPolicy) -> Self {
        Self {
            policy,
            gates: Arc::default(),
            counters: Arc::default(),
            capacity: DEFAULT_GATE_CAPACITY,
            idle_ttl: DEFAULT_GATE_IDLE_TTL,
        }
    }

    #[cfg(test)]
    fn with_retention(policy: RateLimitPolicy, capacity: usize, idle_ttl: Duration) -> Self {
        Self {
            policy,
            gates: Arc::default(),
            counters: Arc::default(),
            capacity,
            idle_ttl,
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
    ) -> Result<RateLimitPermit, RateLimitWaitCancelled> {
        self.acquire_preferred_cancellable(host, principal, &[model])
            .await
            .map(|(_, permit)| permit)
    }

    /// Acquire the highest preferred model whose cooldown permits a request.
    pub(crate) async fn acquire_preferred_cancellable(
        &self,
        host: &str,
        principal: &str,
        models: &[&str],
    ) -> Result<(usize, RateLimitPermit), RateLimitWaitCancelled> {
        assert!(!models.is_empty(), "preferred model list must not be empty");
        loop {
            let mut fallback_wait: Option<GateWait> = None;
            for (index, model) in models.iter().enumerate() {
                let gate = self.gate(host, principal, model).await;
                let notified = Arc::clone(&gate.notify).notified_owned();
                let cancellation_generation = gate.cancellation_generation.load(Ordering::Acquire);
                let mut state = gate.state.lock().await;
                let now = Instant::now();
                match state.blocked_until {
                    Some(until) if until > now && state.fallback_eligible => {
                        if fallback_wait
                            .as_ref()
                            .is_none_or(|current| until < current.until.unwrap_or(now))
                        {
                            fallback_wait = Some(GateWait {
                                gate: Arc::clone(&gate),
                                model: Arc::from(*model),
                                until: Some(until),
                                notified,
                                cancellation_generation,
                            });
                        }
                    }
                    Some(until) if until > now => {
                        drop(state);
                        wait_for_gate(GateWait {
                            gate: Arc::clone(&gate),
                            model: Arc::from(*model),
                            until: Some(until),
                            notified,
                            cancellation_generation,
                        })
                        .await?;
                        break;
                    }
                    Some(_) if state.probe_in_flight && state.fallback_eligible => {
                        fallback_wait.get_or_insert(GateWait {
                            gate: Arc::clone(&gate),
                            model: Arc::from(*model),
                            until: None,
                            notified,
                            cancellation_generation,
                        });
                    }
                    Some(_) if state.probe_in_flight => {
                        drop(state);
                        wait_for_gate(GateWait {
                            gate: Arc::clone(&gate),
                            model: Arc::from(*model),
                            until: None,
                            notified,
                            cancellation_generation,
                        })
                        .await?;
                        break;
                    }
                    Some(_) => {
                        state.probe_in_flight = true;
                        drop(state);
                        gate.touch(now);
                        return Ok((
                            index,
                            RateLimitPermit {
                                gate: Arc::clone(&gate),
                                probe: true,
                            },
                        ));
                    }
                    None => {
                        drop(state);
                        gate.touch(now);
                        return Ok((
                            index,
                            RateLimitPermit {
                                gate: Arc::clone(&gate),
                                probe: false,
                            },
                        ));
                    }
                }
                if index + 1 == models.len() {
                    if let Some(wait) = fallback_wait.take() {
                        wait_for_gate(wait).await?;
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
        permit.gate.cooldown_active.store(true, Ordering::Release);
        state.fallback_eligible = fallback_eligible;
        if permit.probe {
            state.probe_in_flight = false;
        }
        drop(state);
        permit.gate.touch(Instant::now());
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
        permit.gate.cooldown_active.store(false, Ordering::Release);
        drop(state);
        permit.gate.touch(Instant::now());
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
        permit.gate.touch(Instant::now());
        permit.gate.notify.notify_waiters();
    }

    /// Cancel current cooldown waiters for one exact resolved model.
    pub(crate) async fn cancel_waits(&self, model: &str) -> RateLimitCancellation {
        let gates = self.model_gates(model).await;
        let mut result = RateLimitCancellation {
            model: model.to_owned(),
            matched_keys: gates.len() as u64,
            ..RateLimitCancellation::default()
        };
        for gate in gates {
            let waiters = gate.waiters.load(Ordering::Acquire);
            if waiters == 0 {
                continue;
            }
            gate.cancellation_generation.fetch_add(1, Ordering::AcqRel);
            gate.wait_cancellations
                .fetch_add(waiters, Ordering::Relaxed);
            gate.touch(Instant::now());
            gate.notify.notify_waiters();
            result.cancelled_waiters = result.cancelled_waiters.saturating_add(waiters);
        }
        self.counters
            .wait_cancellations
            .fetch_add(result.cancelled_waiters, Ordering::Relaxed);
        result
    }

    /// Expire cooldowns for one exact model while retaining their probe state.
    pub(crate) async fn release_cooldowns(&self, model: &str) -> RateLimitRelease {
        let gates = self.model_gates(model).await;
        let mut result = RateLimitRelease {
            model: model.to_owned(),
            matched_keys: gates.len() as u64,
            ..RateLimitRelease::default()
        };
        for gate in gates {
            let mut state = gate.state.lock().await;
            if state.blocked_until.is_none() || state.probe_in_flight {
                continue;
            }
            state.blocked_until = Some(Instant::now());
            drop(state);
            gate.cooldown_releases.fetch_add(1, Ordering::Relaxed);
            gate.touch(Instant::now());
            gate.notify.notify_waiters();
            result.released_cooldowns = result.released_cooldowns.saturating_add(1);
        }
        self.counters
            .cooldown_releases
            .fetch_add(result.released_cooldowns, Ordering::Relaxed);
        result
    }

    /// Return identity-free cooldown state aggregated by exact model name.
    pub(crate) async fn model_snapshots(&self) -> Vec<RateLimitModelSnapshot> {
        let gates = self
            .gates
            .lock()
            .await
            .iter()
            .map(|(key, gate)| (key.model.to_string(), Arc::clone(gate)))
            .collect::<Vec<_>>();
        let now = Instant::now();
        let mut snapshots = HashMap::<String, RateLimitModelSnapshot>::new();
        for (model, gate) in gates {
            let state = gate.state.lock().await;
            let wait_cancellations = gate.wait_cancellations.load(Ordering::Relaxed);
            let cooldown_releases = gate.cooldown_releases.load(Ordering::Relaxed);
            if state.blocked_until.is_none() && wait_cancellations == 0 && cooldown_releases == 0 {
                continue;
            }
            let snapshot =
                snapshots
                    .entry(model.clone())
                    .or_insert_with(|| RateLimitModelSnapshot {
                        model,
                        ..RateLimitModelSnapshot::default()
                    });
            snapshot.cooldown_keys = snapshot
                .cooldown_keys
                .saturating_add(u64::from(state.blocked_until.is_some()));
            snapshot.waiters = snapshot
                .waiters
                .saturating_add(gate.waiters.load(Ordering::Relaxed));
            snapshot.probe_keys = snapshot
                .probe_keys
                .saturating_add(u64::from(state.probe_in_flight));
            if let Some(blocked_until) = state.blocked_until {
                snapshot.max_remaining_cooldown_ms = snapshot.max_remaining_cooldown_ms.max(
                    blocked_until
                        .saturating_duration_since(now)
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64,
                );
            }
            snapshot.wait_cancellations = snapshot
                .wait_cancellations
                .saturating_add(wait_cancellations);
            snapshot.cooldown_releases =
                snapshot.cooldown_releases.saturating_add(cooldown_releases);
        }
        let mut snapshots = snapshots.into_values().collect::<Vec<_>>();
        snapshots.sort_by(|left, right| left.model.cmp(&right.model));
        snapshots
    }

    /// Return process-lifetime operator control counts for health output.
    pub(crate) fn control_counters(&self) -> RateLimitControlCounterSnapshot {
        RateLimitControlCounterSnapshot {
            wait_cancellations: self.counters.wait_cancellations.load(Ordering::Relaxed),
            cooldown_releases: self.counters.cooldown_releases.load(Ordering::Relaxed),
        }
    }

    async fn model_gates(&self, model: &str) -> Vec<Arc<KeyGate>> {
        self.gates
            .lock()
            .await
            .iter()
            .filter(|(key, _)| key.model.as_ref() == model)
            .map(|(_, gate)| Arc::clone(gate))
            .collect()
    }

    async fn gate(&self, host: &str, principal: &str, model: &str) -> Arc<KeyGate> {
        let mut gates = self.gates.lock().await;
        let now = Instant::now();
        gates.retain(|_, gate| {
            !gate.is_idle()
                || Arc::strong_count(gate) > 1
                || now.duration_since(gate.last_used()) < self.idle_ttl
        });
        while gates.len() >= self.capacity {
            let candidate = gates
                .iter()
                .filter(|(_, gate)| Arc::strong_count(gate) == 1 && gate.is_idle())
                .min_by_key(|(_, gate)| gate.last_used())
                .map(|(key, _)| key.clone());
            let Some(candidate) = candidate else {
                break;
            };
            gates.remove(&candidate);
        }
        let gate = gates
            .entry(RateLimitKey {
                host: Arc::from(host),
                principal: Arc::from(principal),
                model: Arc::from(model),
            })
            .or_default()
            .clone();
        gate.touch(now);
        gate
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RateLimitKey {
    host: Arc<str>,
    principal: Arc<str>,
    model: Arc<str>,
}

#[derive(Debug)]
struct KeyGate {
    state: Mutex<GateState>,
    notify: Arc<Notify>,
    last_used: StdMutex<Instant>,
    cooldown_active: AtomicBool,
    waiters: AtomicU64,
    cancellation_generation: AtomicU64,
    wait_cancellations: AtomicU64,
    cooldown_releases: AtomicU64,
}

impl Default for KeyGate {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            notify: Arc::default(),
            last_used: StdMutex::new(Instant::now()),
            cooldown_active: AtomicBool::new(false),
            waiters: AtomicU64::new(0),
            cancellation_generation: AtomicU64::new(0),
            wait_cancellations: AtomicU64::new(0),
            cooldown_releases: AtomicU64::new(0),
        }
    }
}

impl KeyGate {
    fn touch(&self, now: Instant) {
        *self.last_used.lock().expect("rate-limit gate clock lock") = now;
    }

    fn last_used(&self) -> Instant {
        *self.last_used.lock().expect("rate-limit gate clock lock")
    }

    fn is_idle(&self) -> bool {
        !self.cooldown_active.load(Ordering::Acquire) && self.waiters.load(Ordering::Acquire) == 0
    }
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

struct GateWait {
    gate: Arc<KeyGate>,
    model: Arc<str>,
    until: Option<Instant>,
    notified: OwnedNotified,
    cancellation_generation: u64,
}

struct GateWaiter(Arc<KeyGate>);

impl GateWaiter {
    fn new(gate: Arc<KeyGate>) -> Self {
        gate.waiters.fetch_add(1, Ordering::Relaxed);
        Self(gate)
    }
}

impl Drop for GateWaiter {
    fn drop(&mut self) {
        self.0.waiters.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn wait_for_gate(wait: GateWait) -> Result<(), RateLimitWaitCancelled> {
    let GateWait {
        gate,
        model,
        until,
        notified,
        cancellation_generation,
    } = wait;
    let _waiter = GateWaiter::new(Arc::clone(&gate));
    if gate.cancellation_generation.load(Ordering::Acquire) != cancellation_generation {
        return Err(RateLimitWaitCancelled {
            model: model.to_string(),
        });
    }
    if let Some(until) = until {
        tokio::select! {
            () = tokio::time::sleep_until(until) => {}
            () = notified => {}
        }
    } else {
        notified.await;
    }
    if gate.cancellation_generation.load(Ordering::Acquire) != cancellation_generation {
        return Err(RateLimitWaitCancelled {
            model: model.to_string(),
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("rate-limit wait cancelled for {model}")]
pub(crate) struct RateLimitWaitCancelled {
    pub(crate) model: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RateLimitCancellation {
    pub(crate) model: String,
    pub(crate) matched_keys: u64,
    pub(crate) cancelled_waiters: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RateLimitRelease {
    pub(crate) model: String,
    pub(crate) matched_keys: u64,
    pub(crate) released_cooldowns: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RateLimitModelSnapshot {
    pub(crate) model: String,
    pub(crate) cooldown_keys: u64,
    pub(crate) waiters: u64,
    pub(crate) max_remaining_cooldown_ms: u64,
    pub(crate) probe_keys: u64,
    pub(crate) wait_cancellations: u64,
    pub(crate) cooldown_releases: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RateLimitControlCounterSnapshot {
    pub(crate) wait_cancellations: u64,
    pub(crate) cooldown_releases: u64,
}

#[derive(Debug, Default)]
struct RateLimitControlCounters {
    wait_cancellations: AtomicU64,
    cooldown_releases: AtomicU64,
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
        let permit = gate.acquire("host", "principal", "model").await.unwrap();
        gate.rejected(&permit, Duration::from_millis(25)).await;
        let started = Instant::now();

        let probe = gate.acquire("host", "principal", "model").await.unwrap();

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
        assert!(!waiting.await.unwrap().unwrap().probe);
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
        let (primary_index, primary) = gate
            .acquire_preferred_cancellable("host", "principal", &models)
            .await
            .unwrap();
        assert_eq!(primary_index, 0);
        gate.rejected_for_fallback(&primary, Duration::from_millis(25))
            .await;

        let (fallback_index, fallback) = gate
            .acquire_preferred_cancellable("host", "principal", &models)
            .await
            .unwrap();
        assert_eq!(fallback_index, 1);
        assert!(!fallback.probe);

        tokio::time::sleep(Duration::from_millis(30)).await;
        let (probe_index, probe) = gate
            .acquire_preferred_cancellable("host", "principal", &models)
            .await
            .unwrap();
        assert_eq!(probe_index, 0);
        assert!(probe.probe);
        gate.completed(&probe).await;

        let (recovered_index, recovered) = gate
            .acquire_preferred_cancellable("host", "principal", &models)
            .await
            .unwrap();
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
        let permit = gate.acquire("host", "principal-a", "model").await.unwrap();
        gate.rejected(&permit, Duration::from_secs(1)).await;

        let other = gate.acquire("host", "principal-b", "model").await.unwrap();

        assert!(!other.probe);
    }

    #[tokio::test]
    async fn evicts_idle_cooldown_keys_at_the_configured_bound() {
        let gate = RateLimitGate::with_retention(
            RateLimitPolicy {
                max_retries: 4,
                initial_delay: Duration::from_millis(10),
                max_delay: Duration::from_secs(1),
                max_wait: Duration::from_secs(1),
            },
            2,
            Duration::from_secs(60),
        );
        drop(gate.acquire("host", "principal-a", "model").await.unwrap());
        drop(gate.acquire("host", "principal-b", "model").await.unwrap());
        drop(gate.acquire("host", "principal-c", "model").await.unwrap());

        assert_eq!(gate.gates.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn cancels_only_current_waiters_for_the_exact_model() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let blocked = gate.acquire("host", "principal", "model-a").await.unwrap();
        gate.rejected(&blocked, Duration::from_secs(1)).await;
        let other = gate.acquire("host", "principal", "model-b").await.unwrap();
        gate.rejected(&other, Duration::from_millis(20)).await;
        let waiting_gate = gate.clone();
        let waiting =
            tokio::spawn(async move { waiting_gate.acquire("host", "principal", "model-a").await });
        let model_gate = gate
            .model_gates("model-a")
            .await
            .into_iter()
            .next()
            .unwrap();
        tokio::time::timeout(Duration::from_millis(100), async {
            while model_gate.waiters.load(Ordering::Acquire) < 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let cancellation = gate.cancel_waits("model-a").await;

        assert_eq!(cancellation.cancelled_waiters, 1);
        assert!(matches!(
            waiting.await.unwrap(),
            Err(RateLimitWaitCancelled { model }) if model == "model-a"
        ));
        let future_waiter = gate.clone();
        let mut future =
            tokio::spawn(
                async move { future_waiter.acquire("host", "principal", "model-a").await },
            );
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut future)
            .await
            .is_err());
        future.abort();
        assert!(future.await.unwrap_err().is_cancelled());
        let model_b = gate.acquire("host", "principal", "model-b").await.unwrap();
        assert!(model_b.probe);
        let model_a = gate
            .model_snapshots()
            .await
            .into_iter()
            .find(|snapshot| snapshot.model == "model-a")
            .unwrap();
        assert_eq!(model_a.waiters, 0);
        assert_eq!(model_a.wait_cancellations, 1);
        assert_eq!(gate.control_counters().wait_cancellations, 1);
    }

    #[tokio::test]
    async fn releases_one_immediate_probe_without_erasing_cooldown_state() {
        let gate = RateLimitGate::new(RateLimitPolicy {
            max_retries: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_secs(1),
            max_wait: Duration::from_secs(1),
        });
        let permit = gate.acquire("host", "principal", "model").await.unwrap();
        gate.rejected(&permit, Duration::from_secs(60)).await;

        let release = gate.release_cooldowns("model").await;
        let probe = gate.acquire("host", "principal", "model").await.unwrap();
        let waiting_gate = gate.clone();
        let mut waiting =
            tokio::spawn(async move { waiting_gate.acquire("host", "principal", "model").await });

        assert_eq!(release.released_cooldowns, 1);
        assert!(probe.probe);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        gate.cancelled(&probe).await;
        let next_probe = waiting.await.unwrap().unwrap();
        assert!(next_probe.probe);
        gate.cancelled(&next_probe).await;
        let snapshots = gate.model_snapshots().await;
        assert_eq!(snapshots[0].cooldown_keys, 1);
        assert_eq!(snapshots[0].cooldown_releases, 1);
        assert_eq!(gate.control_counters().cooldown_releases, 1);
    }

    #[tokio::test]
    async fn capacity_eviction_preserves_active_cooldowns() {
        let gate = RateLimitGate::with_retention(
            RateLimitPolicy {
                max_retries: 4,
                initial_delay: Duration::from_millis(10),
                max_delay: Duration::from_secs(1),
                max_wait: Duration::from_secs(1),
            },
            1,
            Duration::from_secs(60),
        );
        let permit = gate.acquire("host", "principal", "blocked").await.unwrap();
        gate.rejected(&permit, Duration::from_secs(60)).await;
        drop(gate.acquire("host", "principal", "idle").await.unwrap());

        assert_eq!(gate.gates.lock().await.len(), 2);
        assert_eq!(gate.model_snapshots().await[0].model, "blocked");
    }
}
