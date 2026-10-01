# Model proxy adaptive rate-limit and observability plan

Date: 2026-09-30

Status: In progress

## Objective

Make `RATE_LIMIT_MODE=auto` respond to temporary Databricks Foundation Model API
contention without leaving a workspace/model queue locally throttled for the
remaining lifetime of the process. Make the same process easier to operate with
concise default logs, opt-in verbose request details, bounded real-time metrics,
and an optional embedded dashboard.

The target behavior is:

- activate local admission only after a matching upstream input-token 429;
- tighten local admission when matching 429s continue;
- hold the conservative setting long enough to cover multiple one-minute
  upstream windows;
- relax the local restriction in measured steps after sustained clean traffic;
- return the key to unthrottled observation after the restriction reaches zero;
- reactivate immediately if contention returns;
- preserve `on`, `off`, provisioned-throughput, retry, and shared-cooldown
  semantics;
- keep ordinary request logs compact while making rate limiting and failures
  visible at appropriate levels;
- collect bounded process-local connection, request, model, latency, throughput,
  and rate-limit metrics;
- serve an interactive branded dashboard from the existing listener when its
  optional Cargo feature is present.

## Scope and evidence

The current upstream signal is the case-insensitive message `Exceeded workspace
input tokens`. That is evidence for a workspace-level input-token limit, not an
account-wide limit. Account-wide contention remains a hypothesis unless
Databricks returns a quota identifier or documentation that establishes that
scope.

Workspace-level contention can still come from outside this process:

- another proxy replica;
- another application, notebook, job, or user in the workspace;
- requests that share the model but do not pass through this proxy;
- a short burst whose timing overlaps this process's local one-minute window.

The model proxy cannot reconstruct total workspace usage from process-local
reservations. Its adaptive limiter therefore remains a congestion response, not
an assertion that it owns the complete workspace budget.

## Implementation findings

The isolated implementation now includes:

- explicit automatic limiter state with activation, tightening, stepwise
  relaxation, full-budget probation, deactivation, and reactivation;
- separate request ceilings and adaptive rolling budgets, including sole-window
  admission for a request that exceeds the temporary budget but not the ceiling;
- deterministic paused Tokio-time tests for the state lifecycle and health
  counters;
- compact info completions, warn-level operational failures, debug request
  detail, and conventional `-v` / `--verbose` handling under canonical
  `LOG_LEVEL`;
- default-on `ui`, `collect`, and `off` metrics modes with true/false aliases,
  public-access safeguards, bounded history, 32 named model series plus
  `other`, JSON, SSE, and Prometheus routes;
- a static dashboard based on the approved Figma frame, embedded by
  `metrics-ui`, with deterministic canonical brand and Figma status-asset
  validation, model and outcome filters, and request, token, and latency line
  graphs;
- desktop and narrow fixture renders with no browser console errors and
  Lighthouse accessibility, best-practices, and SEO scores of 100;
- additive `metrics` and `metrics-ui` Cargo features with compiling headless and
  metrics-free configurations.

SQLite persistence remains deliberately deferred. Canary traffic, one-week
operational comparison, measured p95 overhead, exact retained heap measurement,
and promotion evidence for making adaptive recovery the operational default
remain outside a local implementation pass. The plan stays active for those
rollout stages.

## Current behavior before this implementation

`RATE_LIMIT_MODE=auto` started every workspace/model key with local token
admission disabled. The first matching input-token 429 flipped an `AtomicBool`
on the key's `TokenQueue`. The key then used the configured or documented ITPM
and OTPM budgets until the process exited. There was no decay, probation, or
deactivation path.

The existing implementation already provided:

- separate input and output rolling windows;
- calibrated input estimates and reported-usage reconciliation;
- FIFO admission per workspace/model key;
- release of reservations for attempts rejected before token consumption;
- retry reacquisition after an upstream 429;
- a separate host/principal/model cooldown gate for immediate 429 recovery;
- process-local counters through `/healthz`.

The immediate retry gate and the token admission queue solve different
problems. The gate coordinates a short upstream cooldown. Adaptive decay belongs
only in the token admission queue and must not change `Retry-After`, retry
counting, probe serialization, or SSE replay rules.

## Adaptive policy

### 1. Replace the auto-mode boolean with explicit state

Keep `RateLimitMode` unchanged. Replace only `TokenQueue.active` with an
auto-mode state owned by that queue:

```text
Inactive
Enforced {
  penalty_basis_points,
  last_input_429_at,
  last_recovery_step_at,
  clean_successes_since_step,
  full_budget_probation
}
```

Use Tokio `Instant` values. The state is process-local and intentionally resets
to `Inactive` on restart. Do not persist it or add a distributed store.

Manual modes remain simple:

- `on` always applies the complete configured or documented budgets and never
  decays;
- `off` never applies process-local TPM admission;
- provisioned throughput bypasses token admission regardless of mode.

### 2. Represent restriction as a temporary input-budget penalty

The base input budget remains the explicit `INPUT_TOKENS_PER_MINUTE` override or
the documented model ITPM limit.

In auto mode, derive the rolling input budget from a penalty:

```text
effective_window_budget =
  base_input_budget * (10_000 - penalty_basis_points) / 10_000
```

Initial policy:

- first matching input-token 429: 5,000 basis points, allowing 50 percent of the
  base local rolling budget;
- another matching input-token 429 while enforced: add 2,500 basis points;
- maximum penalty: 9,000 basis points, retaining at least 10 percent of the base
  budget;
- clean recovery step: subtract 1,000 basis points.

These values are initial operational defaults, not claims about Databricks'
allocation algorithm. Keep them in one policy struct so tests can use short
durations and later measurements can tune them without spreading constants
through request handling.

An upstream input-token 429 resets all recovery evidence, applies the tightening
step, and starts a new hold period. A matching 429 after full deactivation starts
again at the initial penalty.

Do not infer a safe local share from `error.current`. That value can include
traffic outside this process and does not identify how much capacity belongs to
this proxy.

### 3. Separate the request ceiling from the rolling budget

The queue previously used one input limit both to reject an individually
oversized request and to enforce the rolling window. Adaptive penalties split
those concepts:

- `request_ceiling` remains the complete configured or documented input limit;
- `window_budget` is the temporarily reduced adaptive budget.

A request above `request_ceiling` remains a local structured 429. A request
above the adaptive `window_budget` but at or below `request_ceiling` must not
become permanently impossible to admit.

When the rolling window is empty, allow that request as the key's sole
reservation for the window. While it is present, later requests wait normally.
This preserves the upstream per-request ceiling while still reducing aggregate
local concurrency during contention.

Keep the internal limit type explicit. Do not hide the distinction in a clamp,
because clamping either under-reserves the request or changes a valid request
into an unexplained rejection.

The input signal adjusts only the input rolling budget. Keep output admission at
its configured or documented value while auto mode is enforced. An output-token
429 remains handled by the generic cooldown and retry path until an
output-specific activation signal and policy are designed.

### 4. Require both elapsed time and clean traffic

Absence of a 429 while a key is idle is not evidence that contention ended.
Recovery therefore requires both:

- at least 10 minutes since the most recent matching input-token 429; and
- at least 10 successful upstream responses since the last activation,
  tightening, or recovery step.

After the initial hold:

- permit at most one 1,000-basis-point recovery step every 5 minutes;
- require 10 additional successful responses before each later step;
- reset the clean-success counter after every step;
- do not apply several missed steps at once after an idle period.

Count only upstream 2xx responses as clean evidence. Do not count local
rejections, cancelled requests, network failures, 5xx responses, generic 429s,
or attempts that have not reached an upstream response.

When the penalty reaches zero, keep the queue active at the complete base budget
for one final 5-minute probation interval and 10 additional successful
responses. Then transition to `Inactive`. This catches renewed contention at
the documented ceiling before removing admission entirely.

With the initial defaults, one isolated 429 followed by steady successful
traffic returns to inactive observation in about 40 minutes. Repeated 429s can
extend recovery to about one hour. Both are long enough to span many upstream
one-minute windows without turning a transient busy period into process-lifetime
throttling.

### 5. Evaluate transitions lazily

Do not add a background timer per key. Advance recovery when:

- a request is about to acquire token admission;
- a successful upstream response records clean evidence;
- `/healthz` takes its aggregate snapshot, if doing so can remain read-only.

Lazy evaluation keeps idle keys free of tasks and wakeups. A key must advance by
at most one stage for each qualifying clean-evidence cycle, regardless of how
much wall time passed while it was idle.

Keep one lock order for admission, adaptive state, token windows, and
calibration. Document that order beside the state type and cover cancellation
while waiting so decay does not weaken the existing FIFO and reservation
cleanup guarantees.

### 6. Keep unknown limits unthrottled

Auto activation requires a known base input budget. If neither an explicit
override nor a documented model limit exists:

- retain the generic shared cooldown and retry behavior;
- log that no local input budget was available;
- do not create an active no-op token state.

This avoids reporting an automatic activation that cannot admit or delay
anything.

## Logging policy

### Concise standard logging

Keep collecting detailed request values as metrics, but do not print all of them
at the default log level.

Use these levels:

- `info`: startup configuration, shutdown, model catalogue refresh, one compact
  completion event for an ordinary request, rate-limit relaxation, probation,
  and deactivation;
- `warn`: upstream 429s, automatic activation or tightening, local oversized
  rejection, exhausted retries, upstream 5xx responses, and recoverable
  transport failures;
- `error`: startup failure, invariant failure, or a process-level condition that
  prevents serving requests;
- `debug`: complete request and stream metrics, stream-connected events, retry
  acquisition details, image normalization, and metric-store maintenance.

The compact request completion event contains only:

- resolved model;
- route or client/target protocol pair;
- streaming boolean;
- status;
- total duration.

Do not log peer address, request size, token estimates, token usage, reservation
state, response size, or attempt number on successful standard requests. Those
remain available in verbose logs and metrics.

Emit one completion event for a successful stream. Move the separate
stream-connected event to `debug`. A cancelled stream is `info` when
cancellation is client-driven and `warn` when the upstream body fails.

Rate-limit warnings remain concise but actionable:

- host and resolved model;
- retry number and whether retries are exhausted;
- delay and delay source;
- Databricks `error.message` when present;
- current adaptive state and effective input budget.

Detailed admission state belongs at `debug` and in the dashboard.

### Verbose control

Keep `LOG_LEVEL` as the canonical environment setting. Add the conventional
`-v` / `--verbose` flag as a convenience that selects `debug` when `LOG_LEVEL`
was not explicitly set. Do not introduce a custom `VERBOSE_LOGGING` environment
name.

An explicit `LOG_LEVEL` wins over `--verbose`. Existing `debug`, `info`, `warn`,
and `error` values remain valid. Verbose mode restores the complete structured
request fields but does not dump periodic metric snapshots into logs.

No mode may log request or response bodies, credentials, bearer tokens,
encrypted reasoning, user identity, or embedded binary content.

## Metrics service

### One listener, not a second server

Mount metrics routes on the existing Axum router and listener. The dashboard
uses the same configured `--host` and `--port`:

- `GET /metrics`: embedded graphical dashboard;
- `GET /metrics/snapshot`: current bounded JSON snapshot;
- `GET /metrics/events`: server-sent metric updates;
- `GET /metrics/prometheus`: Prometheus text exposition.

SSE is sufficient because updates flow only from the process to the browser. Do
not add WebSockets or a client command channel. The frontend refreshes the
snapshot once, subscribes to SSE, reconnects with bounded backoff, and pauses
rendering when the page is hidden without stopping collection.

Keep `/healthz` small and machine-oriented. Extend its process-local counters
with:

- `automaticTightenings`;
- `automaticRelaxations`;
- `automaticDeactivations`;
- `automaticReactivations`;
- `autoActiveKeys`;
- `autoProbationKeys`.

The activation counter continues to mean an inactive-to-enforced transition. A
matching 429 on an already enforced key increments `automaticTightenings`
instead. Health output remains aggregate only and does not include time-series
history.

### Metrics mode

Add `--metrics` with environment variable `METRICS`.

The full binary accepts:

- `ui`: collect metrics, expose machine endpoints, and serve the dashboard;
- `collect`: collect metrics and expose the Prometheus and JSON endpoints
  without serving UI assets;
- `off`: do not register metrics middleware, samplers, history, or routes.

Accept `true` as an alias for the build's fullest available mode and `false` as
an alias for `off`. Metrics are on by default. The normal release binary
includes the UI and starts in `ui` mode without requiring a flag or environment
variable, matching the proxy's loopback `127.0.0.1` default listener.
`--metrics off`, `--metrics false`, or `METRICS=off|false` disables collection
and removes all metrics routes.

An operator who binds the proxy to a non-loopback address must explicitly permit
remote dashboard access with `--metrics-public` or `METRICS_PUBLIC=true`.
Without that acknowledgement, continue collecting but return `404` for metrics
routes. Prometheus follows the same restriction unless separately placed behind
an operator-owned authenticated proxy.

This guard is necessary because model names, traffic rates, and limit pressure
are operational data. A read-only route is not automatically safe to publish.
Forwarded headers must not bypass the guard. If Caddy or another local reverse
proxy should expose the dashboard, the operator must opt in explicitly and own
front-door authentication.

### Collected measurements

Collect:

- process uptime;
- current connections, active HTTP requests, and active streams;
- request totals by bounded route, protocol, status class, streaming mode, and
  resolved model;
- request and stream duration distributions with p50, p95, and p99;
- input and output byte throughput;
- estimated and reported input/output token throughput;
- retry attempts, delay sources, and exhausted retries;
- current auto-throttle state, penalty, base and effective input budgets,
  admission waits, queue depth, oversized rejections, and input-token 429s;
- active model count and per-model request, token, latency, error, and 429
  summaries;
- stream completions, cancellations, and failures.

Do not use principal, user, email, peer address, request ID, thread ID, or raw
path as metric labels. Normalize routes before recording them. Limit per-model
series to the 32 named resolved models and combine additional models under
`other`. Cap all registries and history maps so a caller-controlled model string
cannot create unbounded cardinality.

Record one typed request outcome through one metrics runtime. Logging and the
metrics store consume that same outcome rather than independently recomputing
status, timing, bytes, tokens, or rate-limit state.

### Rust libraries

Use the Rust ecosystem rather than implementing counters, histogram math,
exposition, and static-asset handling independently:

- `metrics` for instrumentation;
- `metrics-exporter-prometheus` for the in-process recorder and
  `PrometheusHandle`, rendered through the existing Axum route;
- `hdrhistogram` for bounded latency quantiles used by JSON;
- `rust-embed` plus `mime_guess` for feature-gated compile-time dashboard
  assets and content types;
- existing Axum and Tokio support for JSON and SSE.

Call `PrometheusHandle::run_upkeep` on the bounded SSE sampling interval. Do not
use `metrics-util::debugging::DebuggingRecorder` in production.

## Metrics retention and persistence

### Default to bounded memory

The default store is in-memory and process-local:

- 5-second buckets for the most recent hour;
- 1-minute rollups for the most recent 24 hours;
- at most 32 named model series plus `other`;
- at most 64 non-model series;
- an explicit 16 MiB target and hard cap for retained history.

Store aggregates and bounded histograms only. Never retain individual request
events, payloads, identities, credentials, or peer addresses. Preallocate ring
buffers where practical. Reuse slots as windows advance rather than appending
for the process lifetime.

This is preferable to silently writing under the current working directory:

- containers and Databricks Apps may have ephemeral or read-only filesystems;
- the working directory is deployment source, not application state;
- multiple proxy processes can share a working directory;
- operational model names and traffic history should not appear on disk unless
  the operator requests persistence.

### Optional disk history

Do not flush memory to disk by default. Add persistence only as a separate
`metrics-persistence` Cargo feature after the in-memory dashboard is measured.

If implemented:

- use SQLite through `rusqlite` in WAL mode rather than a custom file format;
- store rollup buckets only, never raw request events;
- flush one transaction every 30 seconds and during graceful shutdown;
- default to seven days and 64 MiB;
- prune oldest buckets before accepting new ones when either bound is reached;
- checkpoint WAL files after pruning;
- accept `--metrics-data-dir` / `METRICS_DATA_DIR`;
- when no explicit directory is provided, use the platform application-data
  directory from the existing `directories` workspace dependency;
- never default to the process working directory;
- derive a stable database name from a hashed workspace host and listener port
  so separate proxy instances do not overwrite one another;
- acquire an exclusive process lock and fall back to memory with one warning if
  the store is already owned.

Persistence remains local diagnostic history. It is not a replacement for an
external Prometheus, OpenTelemetry, or workspace-wide monitoring service.

## Dashboard design and frontend

### Figma workflow

Figma is the design and interactive-prototype source, not the runtime dashboard.
The approved source is:

- file: <https://www.figma.com/design/0qI0u23Tx4jzasligbW6PD>
- desktop frame: `1:294`

Use canonical values from `branding/brand.yaml`: navy, deep blue, Databricks
green, oat surface, slate, warm border, DM Sans, and DM Mono. The dashboard must
work in light and dark contexts even though the portable brand file supplies a
light identity palette.

The main view includes:

- current connections, active requests, active streams, request rate, token
  throughput, p95 latency, and 429 rate summary cards;
- request, token, and latency time-series charts;
- a bounded model table with requests, tokens, p50/p95/p99, errors, retries,
  queue wait, and current rate-limit state;
- a rate-limit timeline showing activation, tightening, recovery, probation,
  and deactivation;
- controls for time range, model selection, and outcome selection;
- draggable and resizable widgets through GridStack;
- clear process-start and retention boundaries so users do not mistake local
  history for workspace-wide history.

### Runtime frontend

Build a static frontend that consumes only snapshot JSON and SSE. It must not
require a Node server, package manager, or network CDN at runtime.

Use GridStack for dashboard placement and resizing. Embed its reviewed
JavaScript, CSS, and license with the dashboard assets. Do not maintain a second
compact/full-detail mode or custom drag-and-resize implementation.

Commit deterministic generated assets that Rust release rows can embed without
installing Bun. Keep focused asset generation and freshness validation in the
normal JavaScript validation path. The Rust build consumes reviewed assets
without invoking a frontend build or downloading packages.

Use immutable caching for versioned JavaScript and CSS assets and no-cache for
the HTML shell and live JSON/SSE endpoints. Keep all assets under `/metrics/` so
the route can be enabled or omitted as one unit.

## Cargo feature boundaries

Use additive optional features:

```text
metrics
metrics-ui = [metrics, embedded asset dependencies]
metrics-persistence = [metrics, SQLite dependencies]
```

The normal release binary enables `metrics-ui` and omits
`metrics-persistence`.

A build with `metrics` but without `metrics-ui`:

- accepts `--metrics=true|false`, with `true` meaning collection;
- also accepts `collect|off`;
- defaults to collection;
- does not accept `ui`;
- contains no UI assets, MIME resolver, or dashboard routes;
- retains Prometheus and bounded JSON collection.

A build without the `metrics` feature:

- compiles instrumentation calls to no-ops or omits them;
- accepts only `--metrics=false`;
- fails startup with a clear build-capability message for `true`, `collect`, or
  `ui`;
- does not pull the metrics recorder, exporter, UI, chart, or persistence
  dependencies.

Test `cargo build` and CLI help under the default feature set,
`--no-default-features --features metrics`, and `--no-default-features`.

## Configuration and rollout

Do not add separate command-line flags for every policy constant in the first
implementation. Keep one internal `AutoRecoveryPolicy` with production defaults
and inject it in tests.

Roll out adaptive rate limiting in three stages:

1. **State and telemetry**
   - Replace the boolean with explicit state.
   - Preserve the existing no-decay behavior while validating counters.
   - Add transition logs, aggregate state, and deterministic tests.

2. **Canary decay**
   - Enable the adaptive implementation in a canary proxy.
   - Observe activations, repeated 429s, post-admission 429s, wait time,
     relaxations, and reactivations.
   - Compare at least one week that includes normal traffic and a known
     high-contention period.

3. **Auto-mode operational default**
   - Confirm recovery behavior when canary data shows no increase in returned
     429s or retry exhaustion.
   - Keep `on` as the explicit never-decay option and `off` as the explicit
     no-local-admission option.

If canary data shows oscillation, increase the clean-success threshold or hold
duration before changing penalty sizes. If it shows persistent post-admission
429s while enforced, tighten the initial and repeated penalties before
lengthening recovery.

Roll out logging and metrics separately:

1. **Concise logging**
   - Introduce the typed request outcome and change log levels without changing
     request behavior.
   - Verify that default logs retain one completion record and every warning or
     failure needed for diagnosis.
   - Verify that `--verbose` or `LOG_LEVEL=debug` reproduces detailed fields.

2. **Headless collection**
   - Add bounded metrics, Prometheus output, snapshot JSON, and cardinality
     guards behind the `metrics` feature.
   - Measure request overhead, memory use, snapshot size, and SSE sampling cost
     under representative streaming and buffered traffic.

3. **Figma and embedded UI**
   - Use the approved Figma design and interaction prototype.
   - Implement the static frontend against snapshot/SSE fixtures.
   - Add the `metrics-ui` feature and deterministic embedded assets.

4. **Optional persistence**
   - Add SQLite only if operators demonstrate that process-lifetime memory is
     insufficient.
   - Keep persistence outside the default release until size, cleanup, locking,
     and shutdown behavior are proven.

## Test plan

Use paused Tokio time or an injected test policy so the suite does not sleep in
real time.

Cover:

- first matching input-token 429 activates at the initial penalty;
- output-token and generic 429s do not activate or tighten the token queue;
- a repeated matching 429 increases the penalty and resets all recovery
  evidence;
- the penalty never exceeds its configured maximum;
- elapsed time without clean traffic does not relax an idle key;
- clean traffic without the minimum elapsed time does not relax a key;
- one qualifying interval applies exactly one recovery step;
- several elapsed intervals do not skip several stages;
- zero penalty enters full-budget probation before deactivation;
- probation deactivates only after both time and clean responses qualify;
- a post-deactivation matching 429 reactivates immediately;
- `on`, `off`, and provisioned-throughput behavior remain unchanged;
- unknown model limits do not create an active no-op state;
- adaptive rolling limits do not lower the complete per-request ceiling;
- one request larger than the adaptive rolling budget but within the base
  ceiling can run alone instead of waiting forever;
- reconciliation, cancellation, FIFO admission, and retry reacquisition remain
  correct across state transitions;
- health counters and active-key gauges reflect transitions accurately.

Add route-level coverage proving that:

- a successful retry after an activating 429 contributes clean evidence only
  after the upstream 2xx response;
- a final returned 429 tightens and resets recovery even when retries are
  exhausted;
- streaming response headers can count as clean evidence without replaying or
  buffering the body;
- immediate retry delays still prefer `Retry-After`, then body
  `error.retry_after`, then the local token window.

Add logging and metrics coverage proving that:

- ordinary successful requests emit only the compact `info` completion fields;
- verbose mode emits complete request, token, attempt, reservation, byte, and
  stream fields;
- every upstream 429 logs at `warn`, including the final attempt and returned
  Databricks message;
- request and response bodies, credentials, identities, encrypted fields, and
  embedded data never appear at any level;
- buffered and streaming requests update active gauges exactly once and return
  them to zero on success, failure, and cancellation;
- route, protocol, status, and model labels remain bounded;
- the thirty-third model enters the `other` series and does not grow the
  registry;
- ring buffers roll over without allocation growth and stay under the
  configured memory cap;
- 5-second data rolls into 1-minute history without double-counting;
- snapshot JSON and Prometheus output agree on counters and gauges;
- histogram fixtures produce expected p50, p95, and p99 ranges;
- an SSE subscriber receives bounded updates and cannot slow request handling;
- `off`, `collect`, `ui`, `true`, and `false` resolve correctly for every tested
  Cargo feature set;
- the normal release binary starts metrics collection and `/metrics` in UI mode
  when no metrics option or environment variable is present;
- the headless metrics build starts collection by default;
- UI assets and routes are absent when `metrics-ui` is not compiled;
- non-loopback dashboard access is refused without explicit public exposure;
- generated frontend assets match canonical brand tokens and Figma assets.

Run load tests with metrics off, headless collection, UI collection without a
viewer, and an active SSE viewer. The p95 request-latency regression from
headless collection should remain below 2 percent, and the full default
in-memory store must remain below its 16 MiB retention cap.

## Documentation updates

Implementation updates:

- `packages/rs/model-proxy/README.md` describes the state lifecycle, logging,
  metrics modes, routes, safeguards, retention, feature builds, and Figma source;
- CLI and environment-variable help includes `--verbose`, `LOG_LEVEL`,
  `--metrics`, `METRICS`, and public-access safeguards;
- `AGENTS.md` records current model-proxy behavior and generated-asset rules;
- this plan remains active because canary and measured performance stages are
  not locally complete.

Describe the limiter as process-local adaptive congestion control. Do not claim
that it enforces an account-wide or complete workspace-wide quota.

## Acceptance criteria

The enhancement is complete when:

- auto-mode keys can return to inactive observation without a process restart;
- no inactive transition occurs from idle wall time alone;
- renewed matching input-token 429s tighten or reactivate immediately;
- a temporary adaptive budget never lowers the complete per-request ceiling;
- retries, shared cooldowns, streaming safety, and manual modes retain their
  current behavior;
- default logs are compact and every rate limit or operational failure remains
  visible at an appropriate level;
- `--verbose` and `LOG_LEVEL=debug` expose detailed structured request metrics
  without sensitive content;
- metrics collection and applicable metrics routes are enabled by default;
- the normal binary serves the Figma-approved branded dashboard at `/metrics`
  from the existing listener;
- headless and metrics-free feature builds contain no UI dependencies or assets;
- metric cardinality, retention, and memory have hard tested bounds;
- metrics history is memory-only by default and never writes to the working
  directory;
- health counters, machine endpoints, and structured logs explain every
  activation, tightening, recovery step, probation, and deactivation;
- tests cover time, traffic, concurrency, cancellation, routes, logging,
  metrics, feature sets, and access controls;
- measured metrics overhead meets the latency and memory limits;
- canary evidence supports the adaptive defaults;
- the README and `AGENTS.md` describe shipped policy and observability;
- the plan is moved to `docs/archived/enhancements` with its final status only
  after canary-only work is complete.
