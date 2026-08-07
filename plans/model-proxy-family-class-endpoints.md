# Model proxy family and class endpoint enhancement plan

## Purpose

Enhance `@dbx-tools/cli-model-proxy` so consumers can list and optionally restrict
Databricks serving endpoints by provider/model family and by the existing model
class taxonomy, while preserving the standard OpenAI `GET /v1/models` contract.

The first required use case is a GPT-only catalogue/proxy. The design should be
reusable for Claude, Gemini, Llama, Qwen, and other recognized families without
scattering name-substring checks throughout the server.

## Current state

The relevant packages are:

- `packages/js/shared/model`: browser-safe model schemas, endpoint summaries,
  family heuristics, capability classification, and OpenAI wire helpers.
- `packages/js/node/model`: live endpoint listing, class bucketing, ranking,
  resolution, and invocation URL selection.
- `packages/js/cli/model-proxy`: OpenAI-compatible HTTP server, Databricks
  backend, CLI flags, and model catalogue serialization.

Current HTTP behavior:

- `GET /v1/models` and `GET /models` return every listed serving endpoint in
  OpenAI's `{ object: "list", data: [...] }` shape.
- A request containing `?client_version=...` receives the Codex
  `{ models: [...] }` shape and only advertises endpoints verified for function
  tools.
- Invocation routes resolve fuzzy model names against the full catalogue.
- `ModelClass` already defines `chat-thinking`, `chat-balanced`, `chat-fast`,
  and `embedding`.
- `classifyByFamily()` currently maps recognizable names to capability classes,
  but there is no first-class provider/model-family type.
- A special `search === "gpt"` rule in `rankModels()` excludes GPT-OSS. That
  policy should eventually use the new family classifier instead of a local
  regular expression.

## Goals

1. Allow standard model-list routes to be filtered by family and exact model
   class.
2. Allow operators to start a proxy restricted to one or more families/classes.
3. Ensure a restricted proxy rejects direct invocation of a hidden model; it
   must not merely hide the model from discovery.
4. Treat OpenAI GPT and GPT-OSS as distinct families.
5. Keep unfiltered `/v1/models` backward compatible.
6. Preserve both OpenAI and Codex catalogue response shapes.
7. Centralize model-family detection in the browser-safe shared-model package.
8. Reuse the existing class classifier/ranker rather than creating a competing
   taxonomy.
9. Add tests and documentation for all public behavior.

## Non-goals

- Changing Databricks Model Serving upstream APIs.
- Replacing the relative quality-based `ModelClass` classifier.
- Guaranteeing that arbitrary custom endpoint names can be assigned a family.
- Adding provider-specific invocation routes such as `/v1/gpt/responses`.
- Changing the response shape of an unfiltered OpenAI model-list request.
- Exposing Databricks SDK internals in model-list responses.

## Proposed public API

### Model-list query parameters

Continue using the OpenAI-compatible routes and add optional filters:

```http
GET /v1/models?family=gpt
GET /v1/models?family=claude
GET /v1/models?class=chat-fast
GET /v1/models?family=gpt&class=chat-balanced
GET /models?family=gpt
```

Semantics:

- `family` is an exact family slug.
- `class` is an exact class bucket, not a capability ceiling.
- Combining filters applies logical AND.
- Unknown family or class values return OpenAI-shaped HTTP `400` errors.
- A valid filter with no matches returns HTTP `200` with an empty list.
- `client_version` continues to select the Codex response envelope after
  filtering. Codex's existing tool-capability filter is also retained.
- Repeated query values are out of scope for the first release; one value per
  dimension keeps behavior deterministic. Multi-family server policy is
  addressed separately below.

Exact class semantics are intentional. Existing model resolution treats a class
as a ceiling so `chat-balanced` can fall back to `chat-fast`. A list endpoint
named `class=chat-balanced` should instead report which models are actually in
that bucket. If ceiling listing is later needed, add a separately named
`max_class` parameter rather than overloading `class`.

### Server-wide restrictions

Add repeatable CLI options and equivalent environment variables:

```sh
dbx model-proxy --model-family gpt
dbx model-proxy --model-family gpt --model-family claude
dbx model-proxy --model-class chat-balanced
```

Proposed environment variables:

```sh
PROXY_MODEL_FAMILIES=gpt,claude
PROXY_MODEL_CLASSES=chat-balanced,chat-fast
```

Policy semantics:

- Multiple values within one dimension are OR-ed.
- Family and class dimensions are AND-ed.
- With no restriction, behavior remains unchanged.
- Restrictions apply to model listing, fuzzy resolution, explicit IDs, chat,
  embeddings, and Responses requests.
- Query filters may narrow the server policy but may never broaden it.
- A model outside policy returns HTTP `400` with an OpenAI-shaped
  `invalid_request_error` before any upstream request is made.
- Restricting to a chat family naturally removes embeddings unless an endpoint
  is explicitly classified into that family. Class `embedding` is the clearer
  way to operate an embedding-only proxy.

The singular `--model-family` and `--model-class` option names should be
repeatable in Commander. Environment variable names are plural because they
hold lists.

### Optional enriched CLI output

`dbx model-proxy models` should include the derived family alongside existing
capabilities:

```json
{
  "name": "databricks-gpt-5-mini",
  "family": "gpt",
  "capabilities": {
    "chat": true,
    "embedding": false,
    "tools": true
  }
}
```

Add matching CLI filters:

```sh
dbx model-proxy models --family gpt
dbx model-proxy models --class chat-fast
dbx model-proxy models --family gpt --tools
```

Do not add nonstandard fields to the default OpenAI `/v1/models` entries in the
first release. Some clients decode that shape strictly. Family/class metadata
can be exposed later through a separate detailed catalogue endpoint if needed.

## Model family taxonomy

Add a string enum and schema to `packages/js/shared/model/src/model.ts`:

```ts
export enum ModelFamily {
  Gpt = "gpt",
  GptOss = "gpt-oss",
  Claude = "claude",
  Gemini = "gemini",
  Gemma = "gemma",
  Llama = "llama",
  Qwen = "qwen",
  Glm = "glm",
  Unknown = "unknown",
}
```

Add `ModelFamilySchema` and export both through the generated package barrel.
Use `unknown` as a derived value, but decide whether it is accepted as a public
filter. Recommended first-release behavior: accept it, enabling operators to
inspect or isolate custom/unrecognized endpoints.

Add a pure classifier to `packages/js/shared/model/src/classify.ts`:

```ts
export function modelFamily(name: string): ModelFamily;
```

Detection order must prevent broad matches from swallowing specific families:

1. GPT-OSS before GPT.
2. Claude.
3. Gemini before Gemma, with explicit independent checks.
4. Llama.
5. Qwen.
6. GLM.
7. Unknown.

Use token/boundary-aware matching where practical. Endpoint names often contain
vendor prefixes and separator-delimited versions, so exact full-name matching
is inappropriate. Tests must protect against accidental matches in unrelated
custom names.

Refactor these existing policies to consume `modelFamily()` where behavior is
equivalent:

- `supportsToolsByFamily()`.
- The GPT-only special case in `rankModels()`.
- Family branches in `classifyByFamily()` where doing so improves clarity.

Do not force all capability-tier logic into `modelFamily()`. Provider family and
capability class are separate concepts: family identifies the lineage; class
uses profile quality or variant clues such as `pro`, `mini`, `opus`, and
`haiku`.

## Internal filtering design

Introduce a reusable pure policy/filter type in shared-model or node-model. The
recommended split is:

- Shared-model owns declarative family/class values and endpoint predicates that
  need no Node runtime.
- Node-model owns exact class bucketing because it already owns class ordering
  and live selection behavior.
- Model-proxy owns HTTP parsing and operator policy enforcement.

Suggested proxy types:

```ts
interface ModelAccessPolicy {
  families?: readonly ModelFamily[];
  classes?: readonly ModelClass[];
}

interface ModelListFilter {
  family?: ModelFamily;
  modelClass?: ModelClass;
}
```

Create one filtering path used by discovery and invocation rather than adding
ad hoc filters to `handleModels()` only. A helper should:

1. Derive each endpoint's family.
2. Classify the complete catalogue once with `classifyEndpoints()`.
3. Build a name-to-class map from the buckets.
4. Apply server policy.
5. Apply request-level list filters.
6. Preserve original/ranked ordering appropriate to the caller.

Classify before family filtering. The current classes are relative quantiles of
the live chat catalogue; filtering to GPT first and then classifying would
silently redefine `chat-thinking`/`chat-balanced`/`chat-fast` for each family.
The class assignment should remain stable for a catalogue snapshot regardless
of which family the caller asks to display.

### Backend contract

The existing `ModelProxyBackend.resolve()` ranks against its internally cached
full catalogue. To enforce restrictions safely, choose one of these designs:

1. **Preferred:** allow resolution against an explicitly supplied eligible
   catalogue, or add a backend resolver method whose loader returns the filtered
   set.
2. Have the proxy resolve normally and reject the resolved endpoint afterward,
   then return a policy error rather than falling through to upstream.

The preferred design produces better fuzzy behavior: if the best global match
is outside policy but a valid in-policy candidate exists, resolution can choose
the valid candidate. It also prevents policy logic from being duplicated after
resolution.

A practical change is to add a pure/backend method that accepts the eligible
endpoint list and delegates to `resolve.rankModelId()` while retaining the
reload-on-miss behavior. On reload, policy must be reapplied before ranking.

### Explicit model IDs

Every POST route must verify the final resolved ID against the policy-derived
eligible catalogue. This closes these bypasses:

- Exact IDs that need no fuzzy rewrite.
- Unknown IDs returned unchanged by the resolver.
- Models deployed after the initial catalogue load.
- Embedding routes sent to a chat-only proxy.

If an ID is not eligible, return a clear `400` such as:

```json
{
  "error": {
    "message": "model databricks-claude-sonnet-4-6 is not allowed by this proxy's model policy",
    "type": "invalid_request_error"
  }
}
```

Do not reveal the complete allowlist in the error response.

## Implementation phases

### Phase 0: Protect the working tree

The repository currently contains many unrelated modified, deleted, and
untracked files. Before implementation:

1. Record `git status --short --branch`.
2. Do not reset, stash, regenerate, or reformat unrelated files without owner
   approval.
3. Prefer a clean worktree or dedicated branch for this enhancement.
4. Limit formatting and test commands to touched packages/files where possible.
5. Inspect diffs before committing to ensure generated-barrel churn and other
   unrelated edits are absent.

### Phase 1: Add the family contract

Files:

- `packages/js/shared/model/src/model.ts`
- `packages/js/shared/model/src/classify.ts`
- `packages/js/shared/model/test/classify.test.ts`
- Generated `packages/js/shared/model/index.ts` via the repo's projen workflow

Tasks:

1. Add `ModelFamily`, descriptions, and `ModelFamilySchema`.
2. Add `modelFamily(name)` with ordered, conservative detection.
3. Add tests for every family, versions, vendor prefixes, mixed case, GPT vs.
   GPT-OSS, and unknown custom endpoints.
4. Refactor existing tool-family and GPT search policy to use the classifier
   where semantics remain unchanged.
5. Verify shared-model stays browser-safe and adds no dependency.

Exit criteria:

- Family classification is deterministic and fully unit tested.
- GPT never includes GPT-OSS.
- Existing class and tool-capability tests remain green.

### Phase 2: Build reusable catalogue metadata/filtering

Files:

- `packages/js/node/model/src/classes.ts` or a focused new source file
- `packages/js/node/model/src/resolve.ts`
- `packages/js/node/model/test/resolve.test.ts`
- Generated `packages/js/node/model/index.ts` as needed

Tasks:

1. Add a helper that maps endpoint names to exact `ModelClass` values from one
   full-catalogue classification pass.
2. Add a pure exact filter supporting family, class, tools, and combinations.
3. Keep `rankModels()` ceiling semantics unchanged.
4. Replace the GPT search exclusion regex with family identity.
5. Test class stability when a family filter is applied.
6. Test unknown endpoints and embeddings explicitly.

Exit criteria:

- Exact list filtering and ceiling-based resolution remain distinct and tested.
- Family filtering does not recalculate relative class boundaries.

### Phase 3: Add HTTP list filters

Files:

- `packages/js/cli/model-proxy/src/server.ts`
- `packages/js/cli/model-proxy/test/server.test.ts` or a focused catalogue test
- `packages/js/cli/model-proxy/test/tool-passthrough.test.ts`

Tasks:

1. Parse `family` and `class` from `/v1/models` and `/models` queries.
2. Validate values with shared schemas/parser helpers.
3. Return `400 invalid_request_error` for invalid values.
4. Apply exact filters before serializing either OpenAI or Codex shape.
5. Retain Codex's tool-capability filter after policy/query filtering.
6. Preserve unfiltered response bytes semantically (ordering and standard
   fields) except for naturally changing live catalogue data.
7. Ensure auth behavior is unchanged.

Exit criteria:

- Standard clients still enumerate unfiltered models.
- Query-filtered OpenAI and Codex catalogues return the expected subsets.
- Empty valid results return a valid empty envelope.

### Phase 4: Add server-wide policy and invocation enforcement

Files:

- `packages/js/cli/model-proxy/src/server.ts`
- `packages/js/cli/model-proxy/src/backend.ts`
- `packages/js/cli/model-proxy/src/cli.ts`
- `packages/js/cli/model-proxy/src/defaults.ts` if environment parsing belongs
  there
- Model-proxy tests

Tasks:

1. Add family/class allowlists to `ProxyServerOptions` and CLI serve options.
2. Parse repeatable CLI flags and comma-separated environment lists.
3. Validate configuration at startup; fail fast on invalid values.
4. Apply policy to `/v1/models` and `/models`.
5. Resolve fuzzy names against the eligible catalogue.
6. Reapply policy after forced catalogue refresh.
7. Reject explicit/out-of-policy IDs before upstream fetch.
8. Apply the same enforcement to chat completions, legacy completions,
   embeddings, and Responses routes.
9. Log the active policy once at startup without logging secrets.
10. Add tests proving forbidden requests never contact the fake upstream.

Exit criteria:

- A GPT-only proxy both advertises and invokes only GPT-family endpoints.
- GPT-OSS is denied by a GPT-only policy unless separately allowed.
- Query parameters cannot broaden configured policy.
- Unrestricted startup remains backward compatible.

### Phase 5: Enhance inspection CLI

Files:

- `packages/js/cli/model-proxy/src/cli.ts`
- CLI tests if present or a new focused CLI test

Tasks:

1. Add derived `family` to `models` and matched `resolve` output.
2. Add `models --family` and `models --class` exact filters.
3. Retain `--chat` and `--tools`; combine all supplied filters with AND.
4. Consider a `--json` flag only if output formats expand later; current output
   is already JSON.

Exit criteria:

- Operators can inspect the exact catalogue visible under a proposed policy
  before starting the server.

### Phase 6: Documentation and examples

Files:

- `packages/js/cli/model-proxy/README.md`
- Root `README.md` only if it already documents model-proxy flags
- Generated API docs through the normal repo workflow if required

Document:

1. Family definitions and the GPT/GPT-OSS distinction.
2. Exact class list semantics versus class-ceiling resolution semantics.
3. HTTP filter examples for OpenAI and Codex clients.
4. GPT-only startup examples.
5. CLI/environment precedence.
6. Error behavior and the fact that policy applies to direct IDs.
7. Unknown/custom endpoint behavior.
8. Security note: family/class policy is an application allowlist, not a
   replacement for Databricks permissions or proxy API-key protection.

## Detailed test matrix

### Shared family classification

- `databricks-gpt-5` -> `gpt`.
- `databricks-gpt-5-mini` -> `gpt`.
- `databricks-gpt-5-3-codex` -> `gpt` unless a future separate Codex family is
  intentionally introduced.
- `databricks-gpt-oss-120b` -> `gpt-oss`, never `gpt`.
- Claude Opus/Sonnet/Haiku -> `claude`.
- Gemini Flash/Pro -> `gemini`.
- Gemma -> `gemma`.
- Meta Llama -> `llama`.
- Qwen -> `qwen`.
- GLM -> `glm`.
- Mixed-case names classify identically.
- Unrecognized/custom names -> `unknown`.
- Boundary tests prevent incidental substrings from becoming false families.

### HTTP model listing

For both `/v1/models` and `/models`:

- No filters returns the existing full OpenAI list.
- `family=gpt` returns GPT and excludes GPT-OSS, Claude, Gemini, and embeddings.
- `family=gpt-oss` returns only GPT-OSS.
- `class=chat-fast` returns exact fast bucket only.
- `class=embedding` returns embedding endpoints only.
- Combined family/class returns their intersection.
- Valid empty intersection returns `200` and `data: []`.
- Invalid family/class returns `400` OpenAI-shaped error.
- API-key requirement still applies before catalogue access.

For Codex (`client_version` present):

- Response retains top-level `models`.
- Family/class filters apply.
- Non-tool-capable endpoints remain excluded.
- Required strict Codex fields remain present.

### Server policy and invocation

- Unrestricted proxy preserves current resolution.
- GPT-only policy lists and invokes GPT.
- GPT-only policy rejects GPT-OSS.
- GPT-only policy rejects an exact Claude ID without touching upstream.
- GPT-only policy fuzzy-resolves to an eligible GPT candidate rather than an
  ineligible global best match.
- Family plus class policy enforces the intersection.
- A request-level filter narrower than policy works.
- A request-level filter outside policy returns an empty list, not broader data.
- Tool requirements continue to filter/reject correctly inside policy.
- Forced refresh after a miss cannot introduce an out-of-policy model.
- Restrictions apply identically to chat, responses, completions, and
  embeddings routes.

### Configuration

- Repeatable CLI values are accumulated.
- Comma-separated environment values are trimmed and deduplicated.
- CLI policy precedence over environment values is documented and tested.
  Recommended precedence: if any CLI value is supplied for a dimension, it
  replaces that dimension's environment list.
- Invalid startup configuration exits with a useful message before binding.
- Empty env strings behave as unset, not as deny-all.

## Validation commands

Use package-local commands from each package's generated task configuration or
root workspace filters. Confirm exact scripts from `package.json` before
running. Expected validation sequence:

```sh
# Format only touched hand-written files.
npx prettier --write \
  packages/js/shared/model/src/model.ts \
  packages/js/shared/model/src/classify.ts \
  packages/js/node/model/src/resolve.ts \
  packages/js/cli/model-proxy/src/server.ts \
  packages/js/cli/model-proxy/src/backend.ts \
  packages/js/cli/model-proxy/src/cli.ts

# Run focused package tests/type checks using the repo's existing scripts.
bun run --filter @dbx-tools/shared-model test
bun run --filter @dbx-tools/model test
bun run --filter @dbx-tools/cli-model-proxy test

# Run synth/barrel generation only when required by this repository, then
# inspect every generated diff before retaining it.
bun run projen

git status --short
git diff --check
git diff -- packages/js/shared/model packages/js/node/model \
  packages/js/cli/model-proxy plans/model-proxy-family-class-endpoints.md
```

Adjust command spelling to the actual root scripts; do not guess by running a
broad generation command in the dirty working tree.

## Compatibility and rollout

### Backward compatibility

- Existing unfiltered HTTP requests are unchanged.
- Existing POST routes and request bodies are unchanged.
- Existing class-ceiling model resolution is unchanged.
- New family/class metadata is additive to the inspection CLI only.
- Configured restrictions are opt-in.

### Suggested rollout order

1. Release family taxonomy and pure filtering first.
2. Release query-filtered model listing with no default restriction.
3. Exercise GPT-only listing against a real workspace.
4. Release opt-in server policy with invocation enforcement.
5. Consider a later detailed metadata endpoint only after observing client need.

### Observability

Add structured logs for:

- Active family/class policy at startup.
- Number of total and eligible models when the catalogue is loaded/refreshed.
- Policy rejection with requested and resolved IDs, but no credentials or
  request body.
- Invalid query filter values at debug/info level; the client already receives
  a `400`.

Avoid per-model startup logs unless debug logging is enabled.

## Risks and mitigations

### Name-based family detection

Databricks does not currently expose a universal provider-family field for every
serving endpoint. Name detection can misclassify custom endpoints.

Mitigation: centralize conservative matching, return `unknown`, test boundaries,
and allow unknown to be explicitly included if operators need custom models.

### GPT versus GPT-OSS ambiguity

A broad `includes("gpt")` check incorrectly includes GPT-OSS.

Mitigation: classify GPT-OSS first and compare enum identity everywhere.

### Relative class instability

Classifying only a filtered family changes quantile boundaries.

Mitigation: classify the full catalogue once, then filter by family/class.

### Discovery-only security gap

Filtering `/v1/models` without checking POST routes allows direct invocation of
hidden models.

Mitigation: use one eligible-catalogue policy for listing and resolution, then
verify the final ID before upstream fetch.

### Strict client decoders

Adding custom fields to OpenAI/Codex list objects could break clients.

Mitigation: preserve existing wire objects in the first release; enrich only the
human-facing CLI output.

### Dirty/generated repository state

Broad formatting or projen generation could mix unrelated changes into the
feature.

Mitigation: use a clean worktree, touch source inputs rather than generated
files manually, inspect generated diffs, and keep commits phase-focused.

## Definition of done

The enhancement is complete when:

1. `ModelFamily` and `modelFamily()` are public, documented, and tested.
2. `/v1/models` and `/models` support validated exact `family` and `class`
   filters in both OpenAI and Codex shapes.
3. `dbx model-proxy --model-family gpt` exposes and invokes GPT models only,
   excluding GPT-OSS.
4. Direct or fuzzy requests cannot bypass configured family/class policy.
5. Existing unrestricted behavior and class-ceiling resolution remain intact.
6. CLI inspection can show/filter family and exact class.
7. Focused shared-model, node-model, and model-proxy test suites pass.
8. Documentation explains filters, policy, precedence, and limitations.
9. Final diff contains no unrelated working-tree or generated-file changes.

## Follow-up enhancements

These should not block the first release:

- A detailed `/v1/model-catalogue` endpoint returning endpoint summaries,
  family, class, profile, dimensions, and capabilities.
- Allow/deny patterns for explicitly approved custom endpoint IDs.
- Endpoint tags as an operator-controlled family override if Databricks exposes
  them consistently.
- A reload/TTL strategy for the CLI backend catalogue instead of process-life
  caching plus forced reload on miss.
- OpenAPI documentation for the proxy's extended discovery routes.
- Metrics for policy rejection counts and eligible catalogue size.
