# dbx-tools-model-proxy

Rust proxy between OpenAI or Anthropic clients and Databricks Model Serving
protocols.

Install and run the version-matched release binary through `dbx`:

```sh
dbx model-proxy --profile PROFILE
```

The first invocation downloads the GitHub release asset matching the installed
`@dbx-tools/cli` version and host platform. Later invocations reuse the
validated executable.

The public crate can also be installed from crates.io:

```sh
cargo install dbx-tools-model-proxy
```

Release builds also publish `dbx-model-proxy` as a GitHub release asset for
each configured platform.

## Per-User Service

Install the proxy for the current user with its optional native tray:

```sh
dbx model-proxy service install --systray auto -- --profile PROFILE
dbx model-proxy service status
```

The lifecycle also provides `start`, `stop`, `restart`, and `uninstall`, with
`remove` as an uninstall alias. Configuration defaults to
`~/.dbx-tools/model-proxy`; pass `--config-dir` to replace it. Uninstall retains
that directory and its SQLite configuration unless `--purge` is explicit.
Service installation injects the stable configuration directory and service
mode into the launched arguments. `--persistence=auto` uses memory for a direct
CLI run and `service.sqlite3` for an installed service. Explicit `memory` and
`sqlite` values override that selection. The same SQLite connection owns
non-secret settings and aggregate metric snapshots. The selected executable is
copied under `<config-dir>/bin`, so autostart never points at a mutable Cargo
target or download cache.

The systray policy is `auto`, `always`, or `never`. Auto is the default and
starts `dbx-model-proxy-tray` only when its native capability probe succeeds.
Always turns an unsupported tray session into an error. Never starts a
companion. The headless proxy remains the registered service process. Every
lifecycle command fails inside a Databricks App, where host OS service
management is unavailable.

The tray target requires the `tray` Cargo feature and has no WebView or product
UI. It shows the proxy address, the resolved current profile with lazily loaded
profile choices, and Quit. The address submenu opens `/v1/models`, Scalar at
`/api`, or GraphiQL at `/graphql` in the system browser. Profile changes call
the same loopback auth API used by other local operators.

macOS and Linux use the native user-level service manager. Windows uses
current-user login startup plus the persisted exact executable and `sysinfo`
process control for functional `start`, `stop`, and `restart`.

The proxy uses `aigw-openai` and `aigw-anthropic` as protocol adapters.
OpenAI Chat Completions and Anthropic Messages requests can target either
Databricks Chat Completions or Responses. Native Responses input currently
targets Responses without conversion.

Authentication comes from `dbx-tools-core`. The proxy resolves the
selected Databricks profile, obtains cached or refreshed credentials, and
retries one upstream `401` after refreshing the rejected token.
`dbx-tools-model` discovers the workspace's serving endpoints, caches the
catalogue for five minutes, and resolves loose model values before forwarding.
For example, `"model": "gpt"` selects the highest-ranked deployed GPT model.

## Authentication And Rate-Limit Identity

`RuntimeManager` owns one atomically replaceable authentication generation.
Each request captures one `Arc` generation before model discovery and retains
it through upstream calls, retries, fallback, throttling, and response
completion. A committed generation owns upstream authentication, while each
incoming request supplies the principal used to partition reactive rate-limit
cooldowns. Identity selection never calls a Databricks API:

- With `dbx model-proxy --profile PROFILE`, `dbx-tools-core` resolves that
exact profile without ambient credential overrides and uses its normal cached
token lifecycle. U2M profiles use the Databricks CLI when available and may
invoke login when renewal requires it.
PAT and U2M requests key cooldowns by the profile name; the token itself is
never part of the key.
- M2M profiles key cooldowns by OAuth client ID. Token refreshes can replace the
access token without changing the rate-limit identity.
- In a Databricks App using App SP, startup resolves
`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, and
`DATABRICKS_CLIENT_SECRET`. The key is therefore the normalized App host,
service-principal client ID, and resolved serving endpoint.
- Trusted `x-forwarded-user` and `x-forwarded-email` headers partition requests
by App user. When those are absent, the proxy may decode `sub`, `user_id`,
`oid`, `client_id`, `azp`, `email`, or `preferred_username` from an incoming
bearer JWT without verifying it. This decode is only a local rate-limit
partitioning hint and never authenticates the request.
- Forwarded OBO identity does not replace the captured generation's upstream
credential. The standalone binary has no request-scoped AppKit context, so
automatic App startup resolves App SP. A global App OBO generation is
prohibited.

The resulting key is `[normalized Databricks host, current principal, resolved model]`. Different users, service principals, hosts, or serving endpoints never
share a cooldown. Keys are stored only in process memory, retain at most 1,024
idle entries, expire after one idle hour, and disappear when the proxy exits.

The manager control contract exposes secret-free profile enumeration, current
status, and switching to ambient resolution or one exact named profile.
Switching refreshes the profile file cache, disables implicit login during a
15-second live endpoint validation, persists the non-secret selection only when
service SQLite is active, and commits the complete generation only after every
step succeeds. Direct CLI mode keeps the selection in process memory. Old
generations drain after their captured requests finish. Profile switching is
disabled inside Databricks Apps. The loopback API exposes current status,
secret-free profile metadata, and exact-profile switching. Tokens, client
secrets, arbitrary hosts, and manual credentials never cross that contract.
A missing or malformed persisted profile is cleared before startup and normal
core profile resolution selects the effective profile.

Token throttle windows are pooled separately by normalized host and workspace
ID. This lets two authentication generations for the same workspace reuse
bounded congestion state without sharing it with another workspace. Model
catalogue cache files add the non-secret principal to that workspace identity.
The pool retains at most 16 inactive workspace entries and removes entries
after 30 idle minutes.

## Run

```sh
cargo run --manifest-path packages/rs/model-proxy/Cargo.toml -- \
  --profile PROFILE --target auto
```

The server listens on `127.0.0.1:4000` by default. `--port` reads
`DATABRICKS_APP_PORT` when present.

Request bodies default to 25 MB through `--max-request-bytes` /
`MAX_REQUEST_BYTES`. Embedded JPEG, PNG, and WebP inputs are detected from their
bytes across OpenAI Chat, Responses, and Anthropic base64 shapes. Images larger
than 2 MB are re-encoded and resized proportionally to at most a 1,568-pixel
edge and 1.15 megapixels before protocol translation. Images at or below 2 MB
and remote image URLs are unchanged, and the proxy never fetches image URLs
itself. Set `--image-resize-threshold-bytes` or
`IMAGE_RESIZE_THRESHOLD_BYTES` to change the size threshold.

`LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`, case-insensitively,
and defaults to `info`. Pass `-v` or `--verbose` to select debug when
`LOG_LEVEL` is absent. An explicit `LOG_LEVEL` always wins. Normal completions
log only the resolved model, route or protocol pair, streaming mode, status,
and total duration. Protocols use lowercase wire labels such as `responses`,
without Rust `Some(...)` or `None` wrappers. Rate limiting, exhausted retries, upstream 5xx responses,
and recoverable transport failures log at `warn`.

Debug completions add request and response byte counts, the immediate TCP peer,
raw and calibrated token estimates, reported usage, attempt count, reservation
state, queue wait, and adaptive budget without logging request bodies,
credentials, identities, encrypted state, or embedded binary content. The token
estimate includes model-visible JSON but excludes encrypted reasoning and
compaction state, signatures, and embedded image, file, audio, and screenshot
payloads. Streams emit their connection event at debug and one completion event
at info or warn.

An upstream SSE body may remain idle for at most two minutes by default.
Thirty seconds without a byte logs one payload-free warning with the byte count,
observed-event count, and last SSE event name. Reaching the deadline emits a
downstream SSE error, records the request as a semantic 504, reconciles its token
reservation, and closes the upstream body without replaying the request. Set
`--stream-idle-timeout-ms` or `STREAM_IDLE_TIMEOUT_MS` to change the deadline.

Pass-through usage comes from complete parsed SSE events while the original
chunks are forwarded unchanged. Observation is capped at 1 MB per event; a
malformed, larger, or unexpectedly queued event disables observation and safely
retains the estimate instead of applying backpressure. Reported usage reconciles
process-local reservations across Chat Completions, Responses, Codex, Anthropic
translations, and embeddings. Unused output reservations are credited
immediately, and actual output is recorded when no maximum was specified. Each
workspace/model queue admits requests FIFO and wakes its head when reconciliation
frees capacity, without blocking unrelated models. After three consistent
samples outside a five-percent noise band, a bounded per-model exponential
moving ratio calibrates raw input estimates against actual usage.
Streaming Chat Completions defaults
`stream_options.include_usage` to `true`; an explicit caller value is
preserved.

Import `postman/model-proxy.postman_collection.json` into Postman. The
collection has separate folders for `--target chat` and `--target responses`;
restart the proxy with the folder's documented command before running it. Set
`chatModel` and `responsesModel` to endpoints available in the selected
workspace.

Supported routes:

- `GET /v1/models`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /api/healthz`
- `GET /api/auth`
- `GET /api/auth/profiles`
- `PUT /api/auth`
- `POST /api/rate-limits/models/{model}/cancel-waits`
- `POST /api/rate-limits/models/{model}/retry-now`
- `GET|POST|WebSocket /graphql`
- `GET /api`
- `GET /api/openapi.yaml`
- `GET /api/openapi.json`
- `GET /api/docs`

Mutation routes require a same-origin loopback request with
`X-Model-Proxy-Control: 1`. GraphQL uses GET for GraphiQL or WebSocket
subscriptions and POST for queries and introspection. HTML requests to `/api`
serve Scalar.

`GET /v1/models` reads the cached live serving-endpoint catalogue. Standard
requests receive an OpenAI `object` / `data` envelope. An `originator` header
whose value starts with `codex` receives a Codex `models` envelope. Both use
the identities returned by Databricks directly: OpenAI uses the serving
endpoint name, while Codex maps `databricks-<model>` to the gateway's
`system.ai.<model>` identity. No `databricks/` or `dbx/` namespace is added.
Requests targeting Responses default a missing `truncation` field to `"auto"`;
an explicit caller value is preserved. Databricks AI Gateway accepts this
default on Open Responses for Claude and Kimi and on Codex Responses for GPT
and Kimi. Claude itself is not enabled on the Codex route.
Unfiltered responses list chat/LLM families first and embedding families
second, alphabetically sorting families within each tier. Each family uses the
same version, variant, and class preference as a search for that family.
Recognized unclassified models remain in the chat/LLM tier. Custom and
unrecognized endpoints sort by name last. Codex priorities follow the resulting
order.

Use `?search=gpt` to apply the same fuzzy scoring and ordering as model
resolution. Add `?extended=true` to include the score, service names,
capability class, profile, task, state, and other catalogue metadata. Extended
output defaults to `false`.

`POST /v1/embeddings` resolves the requested model only among deployed
embedding endpoints, forwards the request to that endpoint's `invocations`
route, and preserves the OpenAI embedding response.

`--target responses` forces Chat Completions or Anthropic Messages input
through the Responses request translator. `--target chat` sends canonical
Chat Completions. `--target auto` selects Responses for Responses clients,
models listed by the current Databricks Responses documentation, Codex clients,
and requests containing Responses-only hosted tools or conversation fields.

Native Responses requests are forwarded without a capability allow-list, so
Databricks-supported `function`, `custom`, `apply_patch`, `shell`,
`image_generation`, `mcp`, and `web_search` tools, image inputs, conversation
state, background mode, and future request fields remain intact. Chat and
Anthropic image blocks are translated to Responses `input_image` content.
Chat-hosted tools are preserved in Responses form instead of being rejected as
malformed function tools. A forced `--target chat` returns a clear client error
for Responses-only features rather than silently dropping them.

Codex model records obtain image-input, web-search, and patch capability sets
from the corresponding Databricks documentation pages. The parsed model lists
are cached for one day and matched against endpoint, model-service, and provider
identities from the live workspace catalogue. The same parser generates a
committed snapshot during repository synthesis, and the binary embeds that
snapshot as its offline fallback. A failed page refresh retains the matching
capabilities from the embedded snapshot without blocking model listing. This
avoids embedding a handwritten model/version matrix while still using the
unified local execution tool shape expected by current Codex clients.

### Codex Catalogue Discovery

Codex discovery is a separate wire contract over the same route:

- a standard `GET /v1/models` receives the OpenAI `data` envelope;
- a request carrying `originator: codex_cli_rs` receives the Codex `models`
envelope used by `codex debug models` and the `/model` picker.

Codex validates the complete remote catalogue before merging it with its bundled
models. One incompatible record causes it to retain the bundled catalogue.
Reasoning levels must therefore remain `{ effort, description }` objects,
`web_search_tool_type` must remain a non-null enum value, and
`supports_search_tool` carries the independent capability flag.

The Codex envelope deliberately excludes embeddings, Claude, Gemini,
unrecognized identities, and endpoint names without the required
`databricks-` prefix. Those models do not become compatible merely because they
appear in the standard OpenAI envelope; adding a family requires separate
Responses and tool-replay validation.

Compare remote and bundled discovery without changing provider configuration:

```sh
codex debug models | jq '.models[] | {slug, visibility}'
codex debug models --bundled | jq '.models[] | {slug, visibility}'
```

Run the bounded real-client regression with an installed Codex 0.148.0:

```sh
RUN_CODEX_DISCOVERY_TESTS=1 RUSTC_WRAPPER= \
  cargo test -p dbx-tools-model --test model \
  codex_real_client_discovers_fixture_catalogue --offline -- --nocapture
```

The test builds the catalogue through `models_payload_with_capabilities`, serves
it from a loopback-only fixture, uses synthetic authentication and an isolated
temporary `CODEX_HOME`, verifies the expected HTTP request, and compares
discovered slugs rather than unstable total counts.

Streaming requests use SSE without buffering the upstream response. Matching
protocols pass the upstream byte stream through directly, including Chat
Completions to Chat Completions and Responses to Responses for Codex clients.
Cross-protocol streams pass through aigateway's stateful Chat Completions or
Responses parser. Anthropic output uses aigateway's native SSE encoder, while
OpenAI Chat Completions output uses the proxy's canonical event encoder.

Responses input currently targets only Responses, so Responses-to-Chat
translation is outside the supported route matrix.

Databricks errors are returned with their original status, body, and content
type. The proxy also forwards `Retry-After`, request and correlation IDs,
rate-limit headers, quota names, and Databricks limit details.

HTTP 429 responses pause the process-local host/principal/model gate described
above. One request probes after the shared cooldown while other streaming and
non-streaming requests for the same key remain paused. The `Retry-After`
response header controls the delay when present, followed by the documented
Foundation Model API `error.retry_after` JSON value. The proxy treats either
value as an upper recovery horizon. A compatible same-family fallback is tried
before sleeping when the horizon exceeds ten seconds. Otherwise, the horizon is
divided across the remaining retries, so a short hint produces smaller probes.
An input-token 429 without either uses the local token-window delay as the same
horizon, or 60 seconds when process-local history cannot explain the workspace
limit. Each incremental wait uses
`RATE_LIMIT_INITIAL_DELAY_MS` as its floor when the horizon permits and
`RATE_LIMIT_MAX_DELAY_MS` as its ceiling. Other 429s use BackON jittered
exponential delays from one second to one minute. Every retry reacquires token
admission and owns exactly one reservation. Every 429 logs a returned
`error.message`, including the final attempt. The default five retries mean one
initial request plus up to five retries.
After the final attempt, or after at most 60 seconds of total rate-limit waiting,
the latest original 429 status, body, and rate-limit headers are returned to the
caller. A local queue timeout before any upstream 429 returns a structured local 429. Configure `RATE_LIMIT_RETRIES`, `RATE_LIMIT_INITIAL_DELAY_MS`,
`RATE_LIMIT_MAX_DELAY_MS`, and `RATE_LIMIT_MAX_WAIT_MS`, or the matching CLI
flags. The maximum wait cannot exceed 60,000 milliseconds. Set retries to `0`
to disable both retries and coordinated cooldowns. Only an initial HTTP 429 is
retried; an SSE error after streaming begins cannot be replayed safely.
Native Responses streams still inspect complete bounded SSE events while
forwarding the original bytes. A terminal `response.failed` or `error` event is
recorded as a failed completion; rate-limit payloads contribute a semantic 429
to the same metrics series as upstream HTTP 429s. Local oversized-input and
wait-budget rejections also contribute to that series.

Same-family fallback uses the live serving catalogue instead of a static model
ladder. It preserves parsed variant tokens at each lower version when possible,
then uses Databricks' live `ai_gateway_model_profile` quality score to choose the
best available variant for that version. Candidates must be ready,
non-deprecated, lower-version endpoints in the same family and must support the
request's protocol, tools, image input, hosted tools, and reasoning effort.
Embeddings do not fallback. The defaults are `same-family`, five lower versions,
and a ten-second wait threshold. Configure them with
`RATE_LIMIT_MODEL_FALLBACK`, `RATE_LIMIT_MODEL_FALLBACK_MAX_STEPS`, and
`RATE_LIMIT_MODEL_FALLBACK_THRESHOLD_MS`, or the matching flags.

The full original cooldown remains attached to the actual endpoint that returned
the 429. Requests use lower candidates until one request probes that endpoint
after expiry; success restores it and another 429 extends its cooldown. Every
gate, token queue, retry, log, and metric is keyed by the actual candidate
endpoint rather than the client's unresolved model string. Responses report the
actual serving model and include `x-model-proxy-preferred-model`,
`x-model-proxy-resolved-model`, and `x-model-proxy-fallback-step` when a fallback
served the request.

Fallback improves availability but does not make model versions behaviorally
identical. Reasoning defaults, structured-output adherence, context limits,
tool behavior, latency, and cost can change between versions. Databricks also
updates and retires models on an ongoing cadence, which is why the proxy uses
live profile, capability, readiness, and retirement metadata rather than a
committed provider ladder. Production evaluations should segment results by the
actual resolved model and treat fallback traffic as a separate quality cohort.

The process-local token queue reads Databricks' published Enterprise
pay-per-token ITPM and OTPM limits from the same daily documentation cache and
generated-fallback pattern used for model capabilities and retirement status.
Input and output windows are tracked separately for each resolved model and
workspace. Requests reserve a `tokenx-rs` input estimate plus any explicit
`max_output_tokens`, `max_completion_tokens`, or `max_tokens` value. Claude
Sonnet 4 reserves its documented 1,000-token default when no output limit is
present. An active queue rejects an input estimate above its complete
per-minute budget with a local structured 429 rather than clamping it.

`RATE_LIMIT_MODE` / `--rate-limit-mode` accepts `auto`, `on`, or `off` and
defaults to `auto`. Auto mode leaves each workspace/model key unthrottled until
its first 429 message containing `Exceeded workspace input tokens`,
case-insensitively. A matching 429 starts with a 10 percent input-budget
penalty, repeated matches add 10 percentage points up to a 90 percent penalty,
and each clean recovery step removes 10 percentage points. Output admission is
not reduced.

Recovery requires both five minutes since the latest matching 429 and five clean
upstream 2xx responses. Later steps require another minute and five clean
responses. Reaching zero penalty immediately deactivates automatic admission,
so a fully relaxed key no longer queues requests. Idle time alone never relaxes
a key, and a renewed matching 429 immediately tightens or reactivates it. The state is
process-local adaptive congestion control and resets when the process exits. It
does not claim ownership of the complete workspace quota.

The complete configured or documented input limit remains the per-request
ceiling. The temporary penalty only reduces the rolling budget. A request above
the adaptive budget but within the complete ceiling can run as the sole
reservation in an empty window, so adaptive recovery cannot make a valid
request impossible to admit. `on` applies complete budgets immediately and
never decays. `off` never applies them. Provisioned throughput bypasses token
admission in every mode. An unknown model limit retains shared cooldown and
retry behavior without creating an active no-op limiter.

Use `INPUT_TOKENS_PER_MINUTE` / `--input-tokens-per-minute` and
`OUTPUT_TOKENS_PER_MINUTE` / `--output-tokens-per-minute` to override the
published limits. Set `PROVISIONED_THROUGHPUT=true` or pass
`--provisioned-throughput` to disable both TPM windows. QPH remains enforced by
Databricks because process-local tracking cannot coordinate a workspace across
proxy replicas. `/api/healthz` reports readiness and the active runtime
generation. GraphQL carries limiter counters and model state. Loopback control
routes can cancel current waits, release cooldowns, enumerate profiles, and
atomically switch the runtime.

## Metrics And Operator APIs

The default `--metrics=auto` enables bounded collection outside a Databricks
App and disables it inside an App. `on` and `true` enable collection
explicitly; `off` and `false` disable it. `METRICS` accepts the same values.

Metrics are strongly typed GraphQL objects at `/graphql`. Send POST queries for
the complete bounded state graph and select only the fields needed, use WebSocket
subscriptions for live client/proxy/upstream events, closed metric windows, and
rate-limit transitions, or open GraphiQL with an HTML GET. GraphiQL starts with
named examples for snapshots, model performance, the unified HTTP exchange,
windows, and rate-limit changes. Every example is type-validated at startup
without running its resolvers. Retained feeds
accept sequence cursors for replay. Introspection includes descriptions for
snapshots, buckets, model performance, reasoning levels, limiter transitions,
process rate-limit health, and retention. There is no separate metrics page,
Prometheus endpoint, or metrics SSE route.

One `requests` subscription carries `CLIENT_REQUEST`, `UPSTREAM_REQUEST`,
`UPSTREAM_RESPONSE`, `CLIENT_RESPONSE`, `UPSTREAM_SSE`, and `CLIENT_SSE` events
with uniform request and response shapes, correlation IDs, elapsed and hop
timings, bodies, models, protocols, and hosts. Each non-SSE hop emits one
log-style event; every parsed SSE frame emits its own event without repeating
HTTP headers. The `include`, `exclude`, and `models` arguments filter events.

Request and non-SSE response bodies are complete and uncapped whenever the live
HTTP topic has a subscriber. Textual UTF-8 media use `content`; binary data
uses a data URL in `content`, while `contentRaw` always carries plain base64.
SSE `data` uses the same parsed JSON or text representation and `dataRaw`
contains its plain base64 bytes.
Complete headers are captured for the live event, but authorization, cookie,
token, and API-key values read `[REDACTED]`. `--show-sensitive` is the only
visibility switch and must be set when the proxy starts to expose those values.
Headers use `name` plus `values[]`; each value provides text in `value` and
plain base64 in `valueRaw`, though examples select only `value`.
Bodies, headers, and HTTP events are live-only and never retained in memory
history or SQLite.

The REST API is generated from the same aide and `axum-typed-routing` handlers
used by the server. Prefer `/api/openapi.yaml`; JSON is available at
`/api/openapi.json` and Scalar at `/api` or `/api/docs`. Run
`dbx-model-proxy --generate-spec [PATH]` to export the same document without
starting the listener. Repository generation consumes that command to publish
the browser-safe `@dbx-tools/openapi-model-proxy` client.

History remains bounded in process memory:

- five-second buckets retain the latest hour;
- one-minute rollups retain the latest 24 hours;
- at most 32 named model series are retained, with additional names combined
under `other`;
- aggregate history targets and caps retained data at 16 MiB;
- no request events, bodies, identities, peers, credentials, or model traffic
are written to disk.

Installed service mode also stores aggregate buckets and model snapshots in the
same `service.sqlite3` used for non-secret service settings. Rows are keyed by a
SHA-256 digest of the stable runtime identity, so the database does not contain
the host, profile, client ID, or user identity. The current runtime's latest
hour of five-second detail and 24 hours of minute rollups are restored after a
restart. `--metrics-store-max-bytes` and `METRICS_STORE_MAX_BYTES` cap aggregate
metric storage at 134217728 bytes by default. Zero disables metric persistence
without disabling SQLite settings. Old runtime snapshots are pruned before a
write and settings remain writable.

## Cargo Features

The default `metrics` feature keeps bounded in-process aggregation available to
the headless runtime:

```sh
cargo build -p dbx-tools-model-proxy --no-default-features --features metrics
```

A metrics-free build resolves `--metrics=auto` to `off`, accepts explicit
`--metrics=false`, and excludes aggregation and histograms:

```sh
cargo build -p dbx-tools-model-proxy --no-default-features
```

`tray` adds the separate `dbx-model-proxy-tray` binary and generic native tray
support from `dbx-tools-service`. The default `dbx-model-proxy` binary remains
headless.
