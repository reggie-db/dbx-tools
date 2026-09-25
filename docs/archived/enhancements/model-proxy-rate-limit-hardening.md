# Model proxy rate-limit hardening plan

Status: Completed and archived September 25, 2026.

This plan addresses the workspace input-tokens-per-minute failure observed on
September 14, 2026:

```text
exceeded retry limit, last status: 429 Too Many Requests,
request id: 4cbaab9a-a5b3-4fc2-93dd-06dde3b08cac
```

The failing `databricks-gpt-5-6-sol` request was estimated at 205,340 input
tokens. The proxy was running with automatic token throttling and five upstream
retries. It waited approximately 48 seconds in total, but still returned the
upstream 429.

## Confirmed failure mechanism

The failure is caused by several behaviors interacting:

1. `RateLimitMode::Auto` does not enforce token admission until a matching
   Databricks input-token 429 activates the model queue. Large requests can
   therefore consume the workspace quota immediately after process startup.
2. Token admission currently happens once before `send_upstream()`. When an
   upstream 429 activates automatic throttling, retries inside
   `send_upstream()` do not reacquire token admission. Activation protects later
   requests but not the request already being retried.
3. A request larger than the documented input-token budget is silently clamped
   to the budget during reservation. The proxy can therefore admit a request it
   cannot accurately represent in its local rolling window.
4. Without a useful upstream `Retry-After`, ordinary exponential backoff can
   exhaust retries before the workspace's rolling 60-second token window has
   cleared.
5. The limiter is process-local. It cannot observe direct workspace traffic,
   other proxy instances, other users, or quota consumed before a restart.

## Goals

- Apply token admission consistently to every upstream attempt.
- Prevent oversized requests from bypassing local budget accounting.
- Wait long enough to recover from an input-token rolling-window 429.
- Preserve ordinary retry behavior for request-count and transient 429s.
- Make logs show why a request waited, retried, or was rejected.
- Keep the limiter safe when upstream usage differs from local estimates.

## Non-goals

- Coordinating quotas across multiple hosts or proxy processes in the first
  implementation.
- Replacing Databricks workspace rate limits with a proxy-defined quota.
- Automatically selecting or changing the configured Databricks profile.
- Increasing retry counts as the primary solution; more retries alone only
  prolong the same failure mode.

## Implementation plan

### Phase 1: make every attempt acquire token admission

Move token admission into the upstream-attempt loop, or pass enough request
metadata into `send_upstream()` to reacquire after automatic activation.

Required behavior:

- The first attempt follows the selected mode: always admitted in `on`, admitted
  only after activation in `auto`, and never token-throttled in `off`.
- When an input-token 429 activates an `auto` queue, the next attempt must call
  token admission before reaching Databricks.
- Each request body is reserved once per actual upstream attempt, not once per
  client request and not twice for the same attempt.
- Failed reservations are released or reconciled consistently so retries do not
  permanently overcount abandoned attempts.
- Request-count admission and token admission remain separate in code and logs.

Primary code areas:

- `packages/rs/model-proxy/src/routes.rs`
- `packages/rs/model-proxy/src/throttle.rs`
- `packages/rs/model-proxy/src/rate_limit.rs`

### Phase 2: define an oversized-request policy

Remove the current `adjusted_input.min(limit)` reservation behavior. Do not
silently represent a request larger than the configured budget as exactly the
budget.

Use an explicit policy:

1. **Default:** reject locally with HTTP 429 and a structured error explaining
   the estimated input tokens and configured per-minute budget.
2. **Optional future mode:** allow one oversized request only when the local
   token window is empty, reserve the full estimate, and block subsequent work
   for the complete rolling window. This mode must be opt-in because it cannot
   guarantee the upstream workspace accepts the request.

The default rejection should advise callers to compact context, reduce
attachments, split the task, or select a model/profile with sufficient quota.
It must not include request contents in logs or responses.

### Phase 3: use token-window-aware 429 recovery

Classify 429 responses before choosing a delay:

- Honor a valid upstream `Retry-After` first.
- For `Exceeded workspace input tokens per minute` without `Retry-After`, delay
  until the local token window can admit the next attempt, with a conservative
  60-second fallback when the proxy lacks enough history.
- Continue using bounded exponential backoff with jitter for unclassified or
  request-count 429s.
- Do not log a delay after retry exhaustion unless the proxy will actually
  sleep for that delay.
- Record the chosen delay source as `retry-after`, `token-window`,
  `token-window-fallback`, or `backoff`.

### Phase 4: improve startup safety

Keep `auto` available, but make its cold-start limitation explicit.

- Document that `auto` is reactive and begins without token reservations.
- Support `rate-limit-mode=on` as the recommended mode when documented model
  limits are trusted and avoiding cold-start bursts is more important than
  maximizing throughput.
- Emit one startup log entry per resolved model limit source: explicit CLI/env,
  documented model metadata, or unavailable.
- Emit a warning when `auto` starts with no active queues and receives a request
  estimated near or above the documented TPM budget.

Changing the application's default mode should be a separate rollout decision
after the corrected admission behavior is validated.

### Phase 5: add diagnostics and operational visibility

Add structured fields to request and retry logs:

- `token_throttle_mode`
- `token_throttle_active`
- `token_limit_input`
- `token_reservation_input`
- `token_window_used_before`
- `token_window_wait_ms`
- `upstream_attempt`
- `retry_delay_source`
- `oversized_request`

Add counters for:

- automatic queue activations
- token-admission waits
- oversized local rejections
- input-token 429s after admission
- retries that reacquired token admission
- fallback full-window delays

These signals should distinguish a bad local estimate from quota consumed by
traffic the proxy cannot observe.

## Test plan

### Unit tests

- `auto` mode remains inactive before a matching input-token 429.
- A matching 429 activates the queue.
- The current request's next retry reacquires token admission after activation.
- Each upstream attempt creates exactly one token reservation.
- A request above the input-token budget is not clamped and admitted.
- An oversized request returns the documented local error response.
- A valid `Retry-After` takes precedence over locally calculated delays.
- An input-token 429 without `Retry-After` waits for the token window or the
  conservative fallback.
- An ordinary 429 continues to use bounded jittered backoff.
- Exhaustion logs no unslept future delay.

### Concurrency tests

- Two near-limit requests cannot both pass token admission in the same local
  window when their combined reservations exceed the budget.
- A request queued before activation is re-evaluated after activation.
- Cancellation while waiting releases admission state and does not deadlock the
  model queue.
- Multiple models and workspaces maintain independent queues.

### Integration tests

Use a mock upstream that returns a Databricks-shaped input-token 429 followed by
success. Verify the exact order:

1. initial attempt
2. automatic activation
3. token-window admission wait
4. retry
5. successful response

Also test a permanently rate-limited upstream to confirm bounded completion,
accurate attempt counts, and no misleading final-delay log.

## Rollout plan

1. Land the retry-reacquisition and oversized-request tests first so they fail
   against the current implementation.
2. Implement Phases 1-3 behind the existing rate-limit modes without changing
   application defaults.
3. Run model-proxy unit and integration tests, then the full Rust workspace
   checks relevant to the changed crates.
4. Deploy to the local application with the user-selected Databricks profile;
   do not infer or substitute a profile during rollout.
5. Exercise several small requests, then concurrent near-limit requests, while
   confirming admission and attempt fields in the logs.
6. Exercise an intentionally oversized synthetic request and confirm it is
   rejected locally without reaching Databricks.
7. Observe at least one real quota-window rollover before considering a default
   change from `auto` to `on`.
8. If stable, evaluate enabling `on` in this application while retaining an
   explicit configuration escape hatch.

## Acceptance criteria

- After `auto` activation, no retry reaches Databricks without token admission.
- Requests estimated above the configured TPM budget are never silently
  clamped and admitted.
- Input-token 429 retries wait for a meaningful quota-window boundary when no
  upstream retry time is provided.
- Logs report actual slept delays and actual upstream attempts accurately.
- Existing non-token 429 retry behavior remains covered and unchanged unless
  explicitly documented.
- The proxy still terminates retries within configured bounds.
- No request payload or sensitive authentication data is added to logs.

## Follow-up: distributed quota coordination

If multiple proxy instances or direct workspace clients remain common, local
admission can still undercount real usage. A later enhancement can store
short-lived reservations in a shared backend such as Redis or PostgreSQL,
partitioned by workspace and model. That work should be considered only after
the single-process retry and oversized-request correctness issues are fixed.
