# Add context-aware `auto` routing to the model gateway

Date: 2026-10-29

Status: Implemented and archived 2026-10-29.

The model gateway now exposes one generic virtual `auto` model across OpenAI
Responses, OpenAI Chat Completions, Anthropic Messages, and Codex-compatible
Responses traffic. Databricks System One classifies each logical user turn,
the existing model package resolves the decision against live compatible
models, and deterministic fallback keeps the gateway available when selection
fails or confidence is low.

Supported chat clients already replay portable message history in each model
request. The implementation therefore does not add a separate conversation
context provider or query Mastra storage. Selector context uses a token budget
rather than a fixed six-message limit, prioritizing the current request and then
the newest prior user and assistant messages. It uses the established
`js-tiktoken` `o200k_base` encoding instead of a local token estimator.

## Goal

Expose one virtual chat model named `auto` from the dbx-tools model gateway.
Clients select `auto` once and continue using the existing OpenAI Responses,
OpenAI Chat Completions, Anthropic Messages, or Codex-compatible API. For each
top-level user turn, the gateway selects an available concrete model and a
compatible reasoning effort from the live Databricks catalogue.

The target range includes:

- greetings, formatting, extraction, and other short deterministic requests;
- routine question answering and tool use;
- research, planning, debugging, and multi-step analysis;
- large code changes and repository-wide refactorings that need a thinking
  model, a high reasoning budget, tools, and a long context window.

The client does not need to understand Databricks endpoint names, provider
protocols, model retirement, reasoning-effort vocabulary, or which models are
currently deployed. Explicit concrete model and reasoning choices remain
available and always override automatic policy.

## Product contract

- `auto` is a virtual generative model id. It is not a new `ModelClass` value
  and is never forwarded to Databricks as an upstream model name.
- `auto` appears in model discovery for the OpenAI and Codex-compatible model
  lists when automatic routing is enabled.
- `model: "auto"` works through Responses, Chat Completions, and Anthropic
  Messages routes. Embeddings continue to use an explicit model or the
  existing `embedding` class.
- One routing decision is made at the beginning of a logical model turn. The
  selected model and reasoning effort remain pinned through that turn's tool
  calls, tool-result replays, retries, and approval suspension or resumption.
- A later user turn may move to a cheaper or more capable model when the
  completed transcript is portable to that model.
- Explicit model ids, model-class selections, and explicit reasoning effort
  always win over automatic selection.
- Requested capabilities are hard constraints. Automatic selection never
  chooses a model without required tool calling, image input, web search,
  structured output, apply-patch, protocol, or context-window support.
- Selector failure does not make the proxy unavailable. A deterministic
  fallback policy selects a compatible balanced model and records the failure.
- Automatic routing remains inside Databricks governance. The initial
  implementation does not send prompts or conversation context to an external
  routing SaaS.
- The selected model, tier, reasoning effort, confidence, decision source, and
  fallback state are observable without logging prompt or response bodies.
- The first release is explicit opt-in through `model: "auto"`. It does not
  change the behavior of omitted model fields or existing unpinned Mastra
  agents until shadow and active-routing evaluation meet the rollout gates.

## Current behavior

The repository already owns most of the execution path needed by `auto`:

- `@dbx-tools/model` discovers the live workspace catalogue, normalizes model
  metadata, ranks endpoints, and classifies chat models as `chat-fast`,
  `chat-balanced`, or `chat-thinking`.
- `@dbx-tools/appkit-model-gateway` accepts explicit model ids or an
  `x-dbx-tools-model-class` header, resolves one compatible target, translates
  protocols when needed, and forwards the request.
- `@dbx-tools/model` and `@dbx-tools/appkit-model-gateway` already normalize
  provider-specific reasoning levels and retry once when an upstream model
  reports a different supported ladder.
- `@dbx-tools/appkit-mastra` stores threads and messages in `PostgresStore`,
  supports semantic recall, and accepts a per-request model override through
  `X-Mastra-Model`.
- Responses calls are intentionally stateless so tool continuations replay
  their reasoning and message state inline.

The current meanings of `auto` are narrower than this proposal:

- An unconfigured Mastra agent has `{ kind: "auto" }`, which means select the
  highest-ranked live default model before the turn. It does not classify the
  current question or change reasoning effort.
- The model gateway's default selection resolves an explicit model, an
  explicit class, or its configured fallback. It does not inspect prompt
  complexity.

The implementation must replace the user-facing meaning of an unpinned
Mastra `auto` turn with the new virtual model behavior without creating a
second model-selection owner.

## Persistence decision

Automatic routing needs only short-lived key-value state to pin one concrete
model and reasoning effort across tool continuations and retries. It does not
need another conversation-history store. The gateway therefore exposes an
injectable `AutomaticRouteStore` and defaults it to AppKit `CacheManager`.

This default is preferable to the alternatives considered:

- AppKit already selects process memory, project-scoped disk, or configured
  Lakebase/PostgreSQL persistence from the application environment. That keeps
  route pins available across replicas without adding a model-gateway database
  dependency.
- Mastra `PostgresStore` owns Mastra thread and message history. Reading it
  would couple a generic chat gateway to one agent framework, duplicate the
  transcript already present in supported chat requests, and exclude non-Mastra
  callers.
- A gateway-owned file is not safe across replicas and would add locking and
  cleanup behavior for state that is already cache-shaped.
- A dedicated expiring Postgres table would duplicate AppKit cache TTL,
  migration, and environment wiring. Consumers that require another backend,
  including SQLite, can supply the same `get`/`set` store interface.

Only route observations are stored: selected model, tier, reasoning effort,
confidence, reason code, source, and selector timing. Prompt and response text
are not persisted by automatic routing.

## Research findings

### Databricks Smart Routing

Unity Gateway Smart Routing is the closest built-in behavior. It examines the
current prompt, recent conversation turns, tool history, available tools, and
session state before routing supported coding-agent subagents among a fixed set
of `system.ai` models.

The current documented integration is coding-agent-specific. It does not
provide a documented general-purpose request API that the AppKit model gateway
can invoke for arbitrary application chat traffic. The implementation should
monitor this feature and delete local decision policy if Databricks exposes a
general model-routing API with the required contract.

### Unity Gateway model-service routing

Normal Unity Gateway model-service routing provides percentage-based traffic
splitting, session affinity, and ordered failure fallbacks. These features are
the governed execution and availability layer. They do not classify request
complexity or select reasoning effort.

### System One and OpenJev

TypeSafe AI System One is a hosted structured-decision API, not a model runtime
that dbx-tools must operate locally. Databricks exposes the decision-optimized
OpenJev model as `system.ai.openjev-qwen35-4b` through Unity Gateway.

OpenJev is based on a 4-billion-parameter Qwen 3.5 model and is designed for
bounded choices, scores, judges, and schema-constrained decisions instead of
prose generation. Databricks owns its serving capacity, authentication,
scaling, usage accounting, and model updates.

This is the preferred online selector for the first implementation. It can
receive a bounded representation of the current turn and return a typed route
decision without introducing another local model process.

### `ai_decide`

`ai_decide` exposes governed decision-model behavior through SQL and REST. It
is a better fit for batch labeling and evaluation than for the latency-critical
online request path.

Use it to classify stored conversations, compare automatic routes with actual
outcomes, produce evaluation datasets, and recalibrate policy thresholds.

### Unity Gateway service policies

LLM-as-judge service policies can inspect a configured conversation window and
use OpenJev. Their documented outcomes govern whether a request is allowed,
denied, or requires confirmation. They do not select a destination model.

Keep safety policy separate from model routing. A request must pass applicable
service policies after `auto` resolves the concrete destination.

### External routers

The implementation should reuse ideas and evaluation methods from existing
routers without adding another gateway owner:

- LiteLLM Auto Routing already supports complexity tiers, recent conversation
  context, heuristic and model-based classification, feedback, and Databricks
  System One. Adopting its proxy would duplicate dbx-tools authentication,
  discovery, protocol translation, capability filtering, and gateway policy.
- RouteLLM provides a trainable strong-versus-weak router and evaluation tools.
  It is a candidate for a later learned policy if stored dbx-tools traffic
  demonstrates that the structured selector cannot meet cost and quality
  targets.
- vLLM Semantic Router provides a broader serving-edge routing stack. It also
  overlaps the existing gateway and would add another runtime and policy owner.
- OpenRouter Auto Router, Azure Model Router, AWS Intelligent Prompt Routing,
  and hosted routing vendors demonstrate the product pattern but move routing
  context outside the Databricks-governed path or constrain the available
  model pool.

Do not add LiteLLM, RouteLLM, vLLM Semantic Router, or a hosted router in the
initial implementation. Reconsider them only if measured evaluation identifies
a capability that System One plus the existing model owner cannot provide.

## Package ownership

### `@dbx-tools/shared-model`

Own browser-safe and serializable automatic-routing contracts:

- automatic route tier;
- routing reason code;
- selector decision source;
- automatic routing decision and observation records;
- reasoning effort selected for a route;
- candidate requirements that cross a process or HTTP boundary.

Use strict Zod schemas with `.describe()` on every schema and field. Export
inferred types. Do not add a parallel interface for a schema-owned record.

Do not add `auto` to `ModelClassSchema`. The existing classes describe concrete
model capability bands. `auto` describes a policy that may select any of those
bands.

### `@dbx-tools/model`

Own pure, runtime-independent routing policy:

- normalize a classifier decision;
- derive hard capability and context requirements from a request summary;
- resolve a decision tier to ranked live candidates;
- apply explicit candidate allowlists and denylists;
- preserve class, capability, retirement, version, cost, speed, and quality
  ranking;
- map a generic requested reasoning budget onto each candidate's supported
  ladder;
- provide deterministic fallback selection when the remote selector is absent,
  times out, or returns an invalid decision;
- produce a reason-coded result suitable for traces and metrics.

This package does not issue the remote System One request. Keep the policy pure
so it can be unit tested over held catalogues and reused by Mastra, the gateway,
CLIs, and generated bindings.

### `@dbx-tools/appkit-model-gateway`

Own online automatic-routing orchestration:

- advertise the synthetic `auto` model;
- recognize `model: "auto"` before normal fuzzy model resolution;
- summarize the current request into bounded selector state;
- call System One/OpenJev through Databricks-authenticated transport;
- validate the structured selector response;
- invoke `@dbx-tools/model` to resolve the concrete target and reasoning effort;
- pin the selected route for the logical turn;
- forward the request through the existing native or translated path;
- attach route observation headers and request tags;
- emit metrics and logs without bodies or secrets.

Do not add a second generic inference proxy, provider registry, reasoning
translator, or endpoint ranker.

### `@dbx-tools/shared-model-gateway`

Own browser-safe discovery and observation fields for the virtual model:

- the `auto` model-list entry;
- automatic capability metadata;
- shared response-header names if selected-route headers are exposed;
- client-side parsing of optional automatic-routing observations.

### `@dbx-tools/appkit-mastra`

Own Mastra-specific context and turn stability:

- identify a top-level user turn and its tool-loop continuations;
- make trusted thread and run identity available to the gateway or model
  builder without treating either value as authorization;
- supply bounded recent history or a rolling summary when the current provider
  request does not already contain the necessary messages;
- pin one selected concrete model and reasoning effort through a Mastra run,
  including approval suspension and resumption;
- record the selected route in MLflow traces;
- keep existing internal fixed-class workloads, such as title generation and
  follow-up suggestions, pinned to their explicit class rather than invoking
  `auto`.

The memory store remains the owner of stored threads and messages. Do not add a
second conversation table for the router.

## Public API contract

### Model discovery

When automatic routing is enabled, model discovery includes one synthetic
record with canonical id `auto`.

The record must:

- remain stable across catalogue refreshes;
- sort before concrete models for Codex-compatible discovery;
- be clearly identified as a routed virtual model in its display name and
  description;
- advertise tool, image, web-search, structured-output, and reasoning support
  only when the routing layer can enforce those requirements against the live
  candidate pool;
- advertise the generic reasoning ladder supported by automatic translation,
  not the ladder of the selector model;
- never expose OpenJev as the selected answer model unless an operator
  explicitly places it in a candidate tier.

The model list remains useful when the selector service is temporarily
unavailable because deterministic fallback continues to support `auto`.

### Inference requests

The existing request bodies remain unchanged:

```json
{
  "model": "auto",
  "input": "Refactor the authorization layer across the repository"
}
```

The same id is accepted in Chat Completions and Anthropic Messages request
shapes.

Precedence is:

1. An explicit concrete model id or fuzzy model request selects that model.
2. An explicit model-class header selects that class.
3. `model: "auto"` invokes automatic routing.
4. Existing configured defaults apply when no request choice is supplied.

Do not interpret arbitrary strings such as `automatic`, `smart`, or `default`
as aliases. One canonical id prevents accidental fuzzy matches.

### Explicit reasoning controls

If a client supplies `reasoning_effort`, `reasoning.effort`, or another
currently supported reasoning field:

- treat it as a hard caller preference;
- require the selected candidate to support a compatible mapped level;
- allow the existing reasoning adapter to translate provider vocabulary;
- do not let the selector silently reduce it;
- return a clear client error when no eligible model can honor it.

When the client supplies no reasoning control, `auto` selects one.

### Route observation

Expose optional response headers through shared constants:

- selected concrete model id;
- selected automatic tier;
- selected wire reasoning effort;
- selector confidence;
- decision source: `selector`, `heuristic`, `cache`, or `fallback`;
- whether route selection degraded after a selector failure.

Finalize header names during implementation after checking existing
model-gateway conventions. Do not add string literals independently to server,
CLI, and browser packages.

Preserve the upstream response body's actual concrete `model` value when one is
present. Do not rewrite it to `auto`; operational transparency is required for
debugging and evaluation.

## Automatic routing decision

Define one strict serialized decision shape. The initial shape should include:

```json
{
  "tier": "fast | balanced | thinking",
  "reasoningEffort": "none | minimal | low | medium | high | xhigh | max",
  "confidence": 0.0,
  "reasonCode": "short_response | extraction | routine_qa | tool_use | research | debugging | code_change | large_refactor | long_context | ambiguous"
}
```

The exact reason-code enum may change while implementing tests, but it must be
bounded. Do not request or store a free-form chain-of-thought explanation from
the selector.

The selector chooses task complexity and reasoning budget. It does not choose a
raw upstream model id. Concrete model selection stays in `@dbx-tools/model`,
where live availability, capabilities, retirement, protocol support, operator
policy, and ranking are already owned.

## Selector context

Build a bounded selector state from information already present at the request
boundary:

- the current user request;
- a bounded number of recent complete user-assistant turns;
- an existing rolling conversation summary when available;
- input token estimate and expected context pressure;
- client protocol and originator;
- whether tools are present and their names, without full tool implementation
  details unless required;
- requested web search, image input, structured output, apply-patch, or custom
  tool behavior;
- whether the request is a new user turn, a tool continuation, or a resumed
  suspended run;
- the previous completed turn's selected tier and result status;
- the eligible tier names after hard capability filtering.

Do not send the entire stored conversation by default. Start with the current
request, two to six complete recent turns, and an existing summary. Set the
final token and turn limits from latency and accuracy measurements rather than
guessing them in configuration.

Do not include:

- access tokens, cookies, authorization headers, or Databricks credentials;
- raw binary or image data;
- hidden tool implementation source;
- user identity fields that are not needed for the decision;
- encrypted provider reasoning;
- unbounded retrieved memory or file contents.

## Routing algorithm

Apply the following order for every top-level turn.

### 1. Resolve explicit choices

Bypass automatic selection for:

- a concrete model id;
- a concrete model-class request;
- embeddings;
- internal package workloads that intentionally request a fixed class;
- an already-pinned tool continuation or resumed run.

### 2. Derive hard requirements

Before calling the selector, derive constraints for:

- protocol compatibility;
- tool calls and complete tool-result replay;
- web search and custom tools;
- image input;
- structured outputs;
- apply-patch support;
- requested reasoning effort;
- context-window capacity;
- model readiness and retirement;
- operator candidate policy.

If no live candidate satisfies the hard requirements, return a clear gateway
error without paying for a selector call.

### 3. Apply deterministic fast paths

Use deterministic policy only where it is safe and measurable:

- preserve a pinned model during a logical turn;
- route protocol- or feature-constrained requests when only one eligible tier
  remains;
- use a cached decision for an identical normalized request and candidate-policy
  version;
- classify requests with explicit caller reasoning according to that requested
  effort rather than asking OpenJev to choose effort again.

Do not build a growing keyword router for greetings, code, or refactoring. Such
rules become a parallel classifier and are difficult to evaluate. OpenJev owns
ambiguous complexity classification.

### 4. Call System One

Call the configured selector model with:

- a fixed dbx-tools-owned instruction and JSON schema;
- bounded selector state;
- eligible tiers rather than all known models;
- a strict timeout and abort signal derived from the client request;
- no retries that outlive the original request deadline.

Validate the complete response with the shared Zod schema. Reject extra fields,
unknown tiers, non-finite confidence, and unsupported reasoning values.

### 5. Resolve a concrete model

Use `@dbx-tools/model` to rank eligible candidates in the chosen tier.

Candidate resolution must account for:

- live quality, speed, and cost profiles;
- family and version ordering;
- required tools and provider features;
- requested context size;
- reasoning support;
- model lifecycle state;
- configured allowlists and denylists;
- whether a tier is intended to prefer open-weight models.

The catalogue does not expose a general licensing field, so `chat-fast` does not
mean open source. The implemented model-owned policy recognizes hosted
open-weight families in one place. Automatic resolution first compares
published Databricks cost profiles when both candidates have them, then applies
that open-weight preference, and finally preserves normal quality/version order.
The gateway, Mastra, CLI, and UI do not duplicate model-name patterns.

### 6. Map reasoning effort

Map the generic selected effort onto the candidate's supported ladder through
the existing reasoning translation owner.

Examples of intended behavior:

- a short formatting request may select `chat-fast` with `none` or `minimal`;
- routine analysis may select `chat-balanced` with `low` or `medium`;
- repository-wide refactoring may select `chat-thinking` with `high`, `xhigh`,
  or `max` when the selected model supports it;
- a thinking model whose lowest accepted value is `medium` receives `medium`
  instead of an unsupported `low` value.

Do not maintain model-specific reasoning rewrites in the automatic router.

### 7. Pin and execute

Store the selected model and effort in request-scoped turn state before the
first upstream call. Reuse them for:

- tool-call continuation;
- tool-result replay;
- provider retry;
- approval suspension and resume;
- streaming reconnect when the framework retries the same turn.

The selector is not called between steps in the same logical turn.

## Turn and conversation stability

Automatic routing must not switch providers in the middle of a reasoning or
tool transcript. Signed reasoning, encrypted reasoning blocks, provider tool
ids, and provider-specific replay requirements make mid-turn switching unsafe.

Use these boundaries:

- model selection may change at the start of a new user turn;
- model selection remains fixed until the turn completes or fails;
- a resumed approval continues with the original route;
- a new turn may use a different model only after the prior assistant turn is
  represented in the canonical portable transcript.

For Mastra, pin the route through trusted request and workflow context. For the
standalone OpenAI-compatible gateway, define one shared optional route-session
convention only if existing request fields cannot identify a continuation.
Before adding a new header, inspect OpenAI Responses, Codex, Anthropic, and
Vercel AI SDK continuation fields and reuse a stable existing identifier where
possible.

Do not use actor id, thread id, request tags, or a client-supplied session id as
authorization.

## Candidate policy

Automatic routing needs three logical candidate pools:

- **fast**: low-cost and low-latency models suitable for short, bounded work;
- **balanced**: general tool-capable models suitable for ordinary application
  and coding work;
- **thinking**: highest-quality reasoning models suitable for long plans,
  difficult debugging, research synthesis, and broad refactoring.

The pool definitions should prefer live catalogue metadata and classes.
Operator configuration may restrict each pool to approved model families or
exact ids. An exact configured candidate that is absent or retired is skipped
with an observable reason.

The fast pool may prefer open-weight models, but automatic routing must not
claim that a model is open source based only on speed, parameter count, or
family name. Add a single model-owned deployment classification or a typed
operator allowlist after inspecting the live metadata available from
Databricks and the committed model snapshots.

Selection does not require that every tier use a different provider. A
workspace may configure multiple sizes or reasoning settings from one family.

## Selector failure and fallback

Failures include:

- selector timeout or cancellation;
- authentication or permission failure;
- System One service unavailability or rate limiting;
- invalid structured output;
- a decision that names an ineligible tier;
- no candidate remaining after catalogue refresh;
- selected candidate rejection caused by stale capability metadata.

Fallback order:

1. Reuse a valid pinned or cached decision for the same logical turn.
2. Resolve a compatible `chat-balanced` model from the live catalogue.
3. Fall back to the existing configured candidate ladder.
4. Fail with the existing no-compatible-model error when hard requirements
   cannot be met.

Do not retry the selector through another general chat model. That would add an
unowned second classifier and unpredictable latency.

A selector failure must never remove hard capability constraints or silently
route image, tool, web-search, structured-output, or long-context traffic to an
incompatible model.

## Stored conversations and evaluation

Stored conversations serve two separate purposes.

### Online context

The implemented router uses the bounded portable transcript already present in
the request. It recognizes that a short message such as `do the rest` may
continue a large refactoring and does not classify from character count alone.
It does not read Mastra storage or query backing tables. Clients that maintain
conversation state remain responsible for replaying portable history.

### Offline labeling and calibration

Build an evaluation dataset from governed stored conversations and traces:

- current user request;
- bounded preceding context;
- actual selected model and reasoning effort;
- tool usage and tool errors;
- completion, cancellation, retry, and approval outcomes;
- latency and token usage;
- user feedback and existing quality scores when present;
- a strong-model or `ai_decide` route label;
- whether a lower-cost candidate produced an acceptable result in replay.

Do not train directly on raw conversations by default. First create a governed
evaluation dataset with retention, access, and redaction rules. User identity
is unnecessary for route learning and should be removed or pseudonymized.

Use stored traffic first for shadow evaluation. A learned RouteLLM-style model
is a later option only after the dataset shows a repeatable quality or cost gap
that cannot be corrected with System One instructions and thresholds.

## Configuration contract

Add configuration to the existing model-gateway option owner. Use typed fields
and schemas rather than a string-keyed policy map.

The final field names should cover:

- automatic routing enabled state;
- `off`, `shadow`, and `active` operation modes;
- exact System One selector model, defaulting to
  `system.ai.openjev-qwen3.5-4b`;
- selector timeout;
- bounded recent-turn and selector-input limits;
- minimum confidence for accepting the selector decision;
- tier candidate restrictions;
- open-weight fast-tier policy;
- deterministic fallback tier;
- bounded decision-cache lifetime and size;
- route-observation header and request-tag behavior.

Resolve field names through the root configuration conventions. Use bare
logical keys with `configUtils`; do not introduce `DBX_` environment names.

Avoid configuration for provider-specific reasoning levels. Existing model
metadata and reasoning translation own that behavior.

## Security and governance

- Authenticate the selector call through the same Databricks credential scope
  as the inference request unless an explicitly documented service-principal
  policy requires otherwise.
- Preserve OBO boundaries. A service-principal selector must not gain access to
  conversation state unavailable to the active user.
- Keep route selection and answer inference inside Unity Gateway for the first
  implementation.
- Apply existing model-service permissions and service policies to the selected
  concrete model.
- Bound and redact selector state before serialization.
- Never log selector input, raw conversation text, tool arguments, credentials,
  encrypted reasoning, or response bodies.
- Treat classifier output as untrusted data and validate it before selecting a
  route.
- Do not allow request content to replace the dbx-tools selector instruction,
  output schema, candidate policy, or hard constraints.

## Observability

Record these bounded fields for an `auto` request:

- requested virtual model;
- selected concrete model;
- selected tier;
- selected generic and wire reasoning effort;
- selector model;
- confidence;
- bounded reason code;
- decision source;
- selector latency;
- candidate count before and after hard filtering;
- cache or pinned-route hit;
- degraded fallback state;
- final status, latency, and usage already collected by the gateway.

Attach non-sensitive route fields as Unity Gateway request tags when supported
so cost and quality can be analyzed by automatic tier and selected model.

Record the same fields in MLflow traces for Mastra turns. Do not create a
parallel trace store.

Standard logs should contain one compact route-selection event and the existing
completion event. Full candidate lists belong at debug level and must remain
bounded.

## Implementation stages

### Stage 1: contracts and synthetic model

- [ ] Add shared schemas for route tier, reason code, decision source,
  selector decision, and route observation.
- [ ] Add the synthetic `auto` record to OpenAI and Codex model discovery.
- [ ] Make `auto` a reserved exact virtual id that cannot fuzzy-match a real
  endpoint.
- [ ] Reject `auto` for embeddings with a clear request error.
- [ ] Preserve all existing concrete-model and class behavior.
- [ ] Add contract tests for model lists and all supported request protocols.

### Stage 2: pure automatic policy

- [x] Add pure request-requirement and decision-normalization helpers to
  `@dbx-tools/model`.
- [x] Resolve fast, balanced, and thinking decisions against held catalogue
  fixtures.
- [x] Add one owner for open-weight candidate eligibility.
- [x] Reuse existing capability, lifecycle, class, profile, and reasoning
  metadata.
- [x] Add deterministic balanced fallback with bounded reason codes.
- [x] Test missing, retired, incompatible, and stale candidates.

### Stage 3: System One selector in shadow mode

- [x] Add an authenticated System One client at the gateway orchestration
  boundary.
- [x] Build and validate the bounded selector state and response schema.
- [x] Call OpenJev for `auto` requests with confidence-gated fallback.
- [x] Record the selected route, selector latency, confidence, and source
  without logging bodies.
- [ ] Add timeout, cancellation, malformed-output, permission, 429, and 5xx
  tests through a controlled fake transport.
- [x] Confirm selector failure cannot delay a request beyond the configured
  budget.

### Stage 4: active per-turn routing

- [x] Execute the validated selected tier and reasoning effort for explicit
  `model: "auto"` requests.
- [x] Preserve explicit reasoning controls and hard capability constraints.
- [x] Add route observation headers.
- [x] Preserve actual concrete model identity in responses.
- [x] Add bounded cache lifetime and route-policy versioning.
- [x] Verify protocol translation, streaming, cancellation, and usage across
  OpenAI Responses, Chat Completions, Anthropic Messages, and Codex clients.

### Stage 5: turn pinning and Mastra history

- [x] Define a portable logical-turn identity from the request transcript.
- [x] Pin model and reasoning effort across tool continuations.
- [x] Use bounded request-carried context without adding a storage dependency.
- [x] Preserve explicit and single-tier workloads without selector calls.
- [ ] Record route decisions in existing MLflow traces.
- [ ] Test short follow-ups to long tasks and provider-specific reasoning
  replay.

### Stage 6: offline evaluation and calibration

- [ ] Define a governed conversation and outcome evaluation dataset.
- [ ] Batch-label historical turns with `ai_decide` and a strong judge.
- [ ] Replay representative simple, balanced, thinking, tool, research, and
  large-refactor tasks against candidate models.
- [ ] Measure selector accuracy, quality loss, cost, latency, escalation rate,
  fallback rate, and tier stability.
- [ ] Tune selector instruction, confidence threshold, context bound, and
  candidate policy from measured results.
- [ ] Compare the native policy with LiteLLM Auto Routing and RouteLLM on the
  same fixed dataset before considering another dependency.

### Stage 7: default-policy consideration

- [ ] Keep explicit `auto` opt-in until rollout gates pass.
- [ ] Evaluate whether unconfigured Mastra agents should report `auto` instead
  of a concrete default model.
- [ ] Evaluate whether omitted model fields on the standalone proxy should keep
  current behavior or adopt `auto` through an explicit configuration default.
- [ ] Update generated CLI help and model-gateway documentation if defaults
  change.
- [x] Archive the implemented scope. Production calibration and default-policy
  changes remain separate follow-up work.

## Validation plan

### Unit tests

- selector decision schema acceptance and rejection;
- request capability extraction;
- explicit-selection precedence;
- candidate filtering and ranking;
- open-weight fast-tier eligibility;
- context-window filtering;
- reasoning ladder mapping;
- confidence fallback;
- cache key and policy-version behavior;
- no selector call for explicit, embedding, fixed-class, or pinned requests.

### Gateway contract tests

- `GET /v1/models` includes one stable `auto` record;
- OpenAI Responses with `model: "auto"` selects and exposes a concrete model;
- Chat Completions and Anthropic Messages follow the same policy;
- Codex discovery advertises `auto` and valid generic reasoning levels;
- required tools, images, web search, structured output, and apply-patch filter
  candidates before selection;
- explicit reasoning survives selection and translation;
- streaming, cancellation, errors, usage, and finish reasons remain unchanged;
- stateful Responses options remain rejected until the gateway supports them
  independently of automatic routing.

### Turn-stability tests

- one model is used for every step of a tool loop;
- approval resume uses the original model and effort;
- signed or encrypted reasoning is never replayed into a different provider
  during the same turn;
- a later user turn may de-escalate after the prior turn is complete;
- a short continuation of a large task retains sufficient context to avoid an
  incorrect fast route.

### Failure tests

- selector timeout;
- selector 401, 403, 429, and 5xx;
- invalid selector JSON;
- unknown tier or reasoning effort;
- live catalogue refresh failure;
- selected model retired between decision and execution;
- no compatible tool or context candidate;
- gateway restart during a suspended Mastra run;
- decision cache saturation and expiration.

### Evaluation gates

Set exact thresholds after collecting the shadow baseline. Promotion to active
routing requires all of the following categories to have explicit measured
limits:

- no statistically significant quality loss on high-complexity tasks;
- bounded quality loss and material cost or latency improvement on simple work;
- selector p50, p95, and p99 latency within the request budget;
- bounded selector failure and deterministic-fallback rates;
- no capability or tool-compatibility regression;
- no mid-turn model switches;
- no increase in unrecoverable reasoning-replay failures;
- stable or improved user feedback;
- cost attribution visible by route tier and concrete model.

Do not define success only as lower model cost. Include selector calls, reduced
prompt-cache reuse, retries, longer tool loops, and quality-related rework.

## Risks and mitigations

### Selector latency on simple requests

The selector can cost more time than the answer for very small requests.
Measure the full request path, use bounded decision caching, and add only proven
deterministic fast paths.

### Reduced prompt-cache reuse

Changing models between turns can reduce provider prompt-cache hits. Include
cache effects in evaluation and prefer route stability when quality and cost
are otherwise close.

### Incorrect de-escalation on short follow-ups

Short text is not necessarily a simple task. Include recent conversation state
and pin routes through the current logical turn.

### Provider-specific transcript incompatibility

Reasoning signatures and tool identifiers may not be portable mid-turn. Switch
only at completed user-turn boundaries and retain the existing protocol repair
owner.

### Class and license ambiguity

The existing `chat-fast` class is a performance band, not an open-source
classification. Add a single explicit owner for open-weight eligibility before
claiming that simple traffic uses open models.

### Router policy drift

The hosted selector model can change independently of dbx-tools. Version the
dbx-tools selector instruction and candidate policy, retain a fixed evaluation
set, and compare behavior before promoting material selector changes.

### Another gateway owner

Adding LiteLLM or vLLM Semantic Router would duplicate established ownership.
Use an external router only if a measured requirement cannot be implemented
through the existing extension points, and remove overlapping local behavior in
the same change.

## Documentation and generated output

When implementation begins:

- update the owning Zod schema descriptions first;
- run `bun run docs:cli` for changed generated command help;
- update `packages/js/node/appkit-model-gateway/README.md`,
  `packages/js/shared/model-gateway/README.md`, `packages/js/node/model/README.md`,
  and `docs/model-gateway.md` with runnable `auto` examples;
- regenerate API documentation from source;
- run `bun run docs:link-check` for documentation links;
- run `bunx projen` twice for generated configuration changes and require no
  second synthesis diff.

## Reference material

- [Databricks Smart Routing for coding agents](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-model-selection)
- [Unity Gateway traffic splitting and fallbacks](https://docs.databricks.com/aws/en/ai-gateway/configure-traffic-splitting)
- [Unity Gateway service policies](https://docs.databricks.com/aws/en/ai-gateway/service-policies)
- [Databricks System One and agent evaluation](https://docs.databricks.com/aws/en/machine-learning/typesafe-agent-evaluation)
- [Databricks supported foundation models](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/supported-models)
- [Databricks `ai_decide`](https://docs.databricks.com/aws/en/ai-functions/decide)
- [LiteLLM Auto Routing](https://docs.litellm.ai/docs/autorouter_sdk/quickstart)
- [LiteLLM Auto Routing with Databricks System One](https://docs.litellm.ai/docs/autorouter_sdk/typesafe_system_one)
- [RouteLLM](https://github.com/lm-sys/RouteLLM)
- [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)

