//! Optional per-workspace, per-model token reservation queue.

use std::{
    collections::{HashMap, VecDeque},
    num::NonZeroU64,
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub(crate) struct RequestThrottle {
    workspace: Arc<str>,
    tokens_per_minute: Option<NonZeroU64>,
    queues: Arc<Mutex<HashMap<ThrottleKey, Arc<Mutex<WindowState>>>>>,
}

impl RequestThrottle {
    pub(crate) fn new(workspace: &str, tokens_per_minute: Option<NonZeroU64>) -> Self {
        Self {
            workspace: Arc::from(workspace),
            tokens_per_minute,
            queues: Arc::default(),
        }
    }

    pub(crate) async fn acquire(&self, model: &str, request: &Value) -> Duration {
        let Some(tokens_per_minute) = self.tokens_per_minute else {
            return Duration::ZERO;
        };
        let key = ThrottleKey {
            workspace: self.workspace.clone(),
            model: Arc::from(model),
        };
        let queue = {
            let mut queues = self.queues.lock().await;
            queues.entry(key).or_default().clone()
        };
        let tokens = estimated_tokens(request).min(tokens_per_minute.get());
        reserve(queue, tokens, tokens_per_minute.get(), WINDOW).await
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ThrottleKey {
    workspace: Arc<str>,
    model: Arc<str>,
}

#[derive(Debug, Default)]
struct WindowState {
    reservations: VecDeque<(Instant, u64)>,
    reserved_tokens: u64,
}

impl WindowState {
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

async fn reserve(
    queue: Arc<Mutex<WindowState>>,
    tokens: u64,
    limit: u64,
    window: Duration,
) -> Duration {
    let started = Instant::now();
    let mut state = queue.lock().await;
    loop {
        let now = Instant::now();
        state.prune(now, window);
        if let Some(delay) = state.delay(now, tokens, limit, window) {
            tokio::time::sleep(delay).await;
            continue;
        }
        state.reserve(now, tokens);
        return started.elapsed();
    }
}

fn estimated_tokens(request: &Value) -> u64 {
    let input_bytes = serde_json::to_vec(request)
        .map(|body| body.len() as u64)
        .unwrap_or_default();
    let input_tokens = input_bytes.div_ceil(4).max(1);
    input_tokens.saturating_add(requested_output_tokens(request))
}

fn requested_output_tokens(request: &Value) -> u64 {
    ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .into_iter()
        .find_map(|field| request.get(field).and_then(Value::as_u64))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn estimates_input_and_requested_output_tokens() {
        let request = json!({"model": "gpt", "input": "hello", "max_output_tokens": 50});
        assert!(estimated_tokens(&request) >= 50);
        assert_eq!(requested_output_tokens(&request), 50);
    }

    #[test]
    fn window_state_reports_oldest_reservation_delay() {
        let now = Instant::now();
        let mut state = WindowState::default();
        state.reserve(now, 80);
        assert_eq!(state.delay(now, 20, 100, WINDOW), None);
        assert_eq!(state.delay(now, 21, 100, WINDOW), Some(WINDOW));
    }
}
