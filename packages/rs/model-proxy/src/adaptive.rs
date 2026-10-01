//! Process-local adaptive input-token congestion state.

use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

const BASIS_POINTS: u64 = 10_000;

/// Recovery policy for automatic input-token admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AutoRecoveryPolicy {
    pub(crate) initial_penalty_basis_points: u16,
    pub(crate) tightening_basis_points: u16,
    pub(crate) maximum_penalty_basis_points: u16,
    pub(crate) recovery_basis_points: u16,
    pub(crate) initial_hold: Duration,
    pub(crate) recovery_interval: Duration,
    pub(crate) clean_successes: u32,
}

impl Default for AutoRecoveryPolicy {
    fn default() -> Self {
        Self {
            initial_penalty_basis_points: 5_000,
            tightening_basis_points: 2_500,
            maximum_penalty_basis_points: 9_000,
            recovery_basis_points: 1_000,
            initial_hold: Duration::from_secs(10 * 60),
            recovery_interval: Duration::from_secs(5 * 60),
            clean_successes: 10,
        }
    }
}

/// Stable transition vocabulary shared by logs, health counters, and metrics.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutoTransitionKind {
    Activated,
    Tightened,
    Relaxed,
    Probation,
    Deactivated,
    Reactivated,
}

/// One automatic congestion-control transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoTransition {
    pub(crate) kind: AutoTransitionKind,
    pub(crate) penalty_basis_points: u16,
    pub(crate) base_input_budget: u64,
    pub(crate) effective_input_budget: u64,
}

/// Current automatic state for one workspace/model key.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoSnapshot {
    pub(crate) active: bool,
    pub(crate) penalty_basis_points: u16,
    pub(crate) clean_successes: u32,
    pub(crate) probation: bool,
}

#[derive(Clone, Copy, Debug)]
struct EnforcedState {
    penalty_basis_points: u16,
    last_input_429_at: Instant,
    last_recovery_step_at: Instant,
    clean_successes_since_step: u32,
    full_budget_probation: bool,
}

#[derive(Clone, Copy, Debug, Default)]
enum AutoPhase {
    #[default]
    Inactive,
    Enforced(EnforcedState),
}

/// Adaptive limiter state owned by a token queue.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct AutoLimiter {
    phase: AutoPhase,
    activated_before: bool,
}

impl AutoLimiter {
    /// Activate or tighten admission after a matching input-token 429.
    pub(crate) fn record_input_429(
        &mut self,
        now: Instant,
        base_input_budget: u64,
        policy: AutoRecoveryPolicy,
    ) -> AutoTransition {
        let kind = match &mut self.phase {
            AutoPhase::Inactive => {
                let kind = if self.activated_before {
                    AutoTransitionKind::Reactivated
                } else {
                    AutoTransitionKind::Activated
                };
                self.activated_before = true;
                self.phase = AutoPhase::Enforced(EnforcedState {
                    penalty_basis_points: policy.initial_penalty_basis_points,
                    last_input_429_at: now,
                    last_recovery_step_at: now,
                    clean_successes_since_step: 0,
                    full_budget_probation: false,
                });
                kind
            }
            AutoPhase::Enforced(state) => {
                state.penalty_basis_points = state
                    .penalty_basis_points
                    .saturating_add(policy.tightening_basis_points)
                    .min(policy.maximum_penalty_basis_points);
                state.last_input_429_at = now;
                state.last_recovery_step_at = now;
                state.clean_successes_since_step = 0;
                state.full_budget_probation = false;
                AutoTransitionKind::Tightened
            }
        };
        self.transition(kind, base_input_budget)
    }

    /// Record one clean upstream response and apply at most one recovery step.
    pub(crate) fn record_success(
        &mut self,
        now: Instant,
        base_input_budget: u64,
        policy: AutoRecoveryPolicy,
    ) -> Option<AutoTransition> {
        let AutoPhase::Enforced(state) = &mut self.phase else {
            return None;
        };
        state.clean_successes_since_step = state.clean_successes_since_step.saturating_add(1);
        if state.clean_successes_since_step < policy.clean_successes
            || now.duration_since(state.last_input_429_at) < policy.initial_hold
            || now.duration_since(state.last_recovery_step_at) < policy.recovery_interval
        {
            return None;
        }

        if state.penalty_basis_points > 0 {
            state.penalty_basis_points = state
                .penalty_basis_points
                .saturating_sub(policy.recovery_basis_points);
            state.clean_successes_since_step = 0;
            state.last_recovery_step_at = now;
            let kind = if state.penalty_basis_points == 0 {
                state.full_budget_probation = true;
                AutoTransitionKind::Probation
            } else {
                AutoTransitionKind::Relaxed
            };
            return Some(self.transition(kind, base_input_budget));
        }

        self.phase = AutoPhase::Inactive;
        Some(self.transition(AutoTransitionKind::Deactivated, base_input_budget))
    }

    pub(crate) fn snapshot(self) -> AutoSnapshot {
        match self.phase {
            AutoPhase::Inactive => AutoSnapshot {
                active: false,
                penalty_basis_points: 0,
                clean_successes: 0,
                probation: false,
            },
            AutoPhase::Enforced(state) => AutoSnapshot {
                active: true,
                penalty_basis_points: state.penalty_basis_points,
                clean_successes: state.clean_successes_since_step,
                probation: state.full_budget_probation,
            },
        }
    }

    pub(crate) fn effective_input_budget(self, base_input_budget: u64) -> Option<u64> {
        let AutoPhase::Enforced(state) = self.phase else {
            return None;
        };
        Some(effective_budget(
            base_input_budget,
            state.penalty_basis_points,
        ))
    }

    fn transition(self, kind: AutoTransitionKind, base_input_budget: u64) -> AutoTransition {
        let snapshot = self.snapshot();
        AutoTransition {
            kind,
            penalty_basis_points: snapshot.penalty_basis_points,
            base_input_budget,
            effective_input_budget: self
                .effective_input_budget(base_input_budget)
                .unwrap_or(base_input_budget),
        }
    }
}

fn effective_budget(base_input_budget: u64, penalty_basis_points: u16) -> u64 {
    base_input_budget
        .saturating_mul(BASIS_POINTS.saturating_sub(u64::from(penalty_basis_points)))
        .checked_div(BASIS_POINTS)
        .unwrap_or_default()
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_policy() -> AutoRecoveryPolicy {
        AutoRecoveryPolicy {
            initial_penalty_basis_points: 5_000,
            tightening_basis_points: 2_500,
            maximum_penalty_basis_points: 9_000,
            recovery_basis_points: 1_000,
            initial_hold: Duration::from_secs(10),
            recovery_interval: Duration::from_secs(5),
            clean_successes: 2,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn activates_tightens_and_caps_the_penalty() {
        let mut limiter = AutoLimiter::default();
        let policy = test_policy();

        let activated = limiter.record_input_429(Instant::now(), 1_000, policy);
        assert_eq!(activated.kind, AutoTransitionKind::Activated);
        assert_eq!(activated.penalty_basis_points, 5_000);
        assert_eq!(activated.effective_input_budget, 500);

        for expected in [7_500, 9_000, 9_000] {
            let tightened = limiter.record_input_429(Instant::now(), 1_000, policy);
            assert_eq!(tightened.kind, AutoTransitionKind::Tightened);
            assert_eq!(tightened.penalty_basis_points, expected);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn requires_elapsed_time_and_clean_traffic_for_each_step() {
        let mut limiter = AutoLimiter::default();
        let policy = test_policy();
        limiter.record_input_429(Instant::now(), 1_000, policy);

        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(limiter.record_success(Instant::now(), 1_000, policy), None);
        let relaxed = limiter
            .record_success(Instant::now(), 1_000, policy)
            .expect("clean traffic relaxes one step");
        assert_eq!(relaxed.kind, AutoTransitionKind::Relaxed);
        assert_eq!(relaxed.penalty_basis_points, 4_000);

        for _ in 0..2 {
            assert_eq!(limiter.record_success(Instant::now(), 1_000, policy), None);
        }
        tokio::time::advance(Duration::from_secs(5)).await;
        let relaxed = limiter
            .record_success(Instant::now(), 1_000, policy)
            .expect("the next interval relaxes exactly once");
        assert_eq!(relaxed.penalty_basis_points, 3_000);
    }

    #[tokio::test(start_paused = true)]
    async fn enters_probation_before_deactivation_and_reactivates() {
        let policy = AutoRecoveryPolicy {
            recovery_basis_points: 5_000,
            ..test_policy()
        };
        let mut limiter = AutoLimiter::default();
        limiter.record_input_429(Instant::now(), 1_000, policy);
        tokio::time::advance(Duration::from_secs(10)).await;
        assert!(limiter
            .record_success(Instant::now(), 1_000, policy)
            .is_none());
        let probation = limiter
            .record_success(Instant::now(), 1_000, policy)
            .expect("zero penalty begins probation");
        assert_eq!(probation.kind, AutoTransitionKind::Probation);
        assert!(limiter.snapshot().probation);

        for _ in 0..2 {
            assert!(limiter
                .record_success(Instant::now(), 1_000, policy)
                .is_none());
        }
        tokio::time::advance(Duration::from_secs(5)).await;
        let deactivated = limiter
            .record_success(Instant::now(), 1_000, policy)
            .expect("probation completes after time and traffic");
        assert_eq!(deactivated.kind, AutoTransitionKind::Deactivated);
        assert!(!limiter.snapshot().active);

        let reactivated = limiter.record_input_429(Instant::now(), 1_000, policy);
        assert_eq!(reactivated.kind, AutoTransitionKind::Reactivated);
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_429_resets_recovery_evidence() {
        let mut limiter = AutoLimiter::default();
        let policy = test_policy();
        limiter.record_input_429(Instant::now(), 1_000, policy);
        tokio::time::advance(Duration::from_secs(10)).await;
        assert!(limiter
            .record_success(Instant::now(), 1_000, policy)
            .is_none());

        limiter.record_input_429(Instant::now(), 1_000, policy);
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(limiter
            .record_success(Instant::now(), 1_000, policy)
            .is_none());
        assert!(limiter
            .record_success(Instant::now(), 1_000, policy)
            .is_none());
        assert_eq!(limiter.snapshot().penalty_basis_points, 7_500);
    }
}
