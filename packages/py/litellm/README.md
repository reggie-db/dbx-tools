# `dbx-tools-litellm`

Thin LiteLLM integration for Databricks Model Serving. It adds live endpoint
discovery and loose model-name resolution, then delegates the unchanged request
to LiteLLM's built-in Databricks provider.

Install from PyPI:

```bash
uv add dbx-tools-litellm
```

To install the current `main` branch directly from the repository instead:

```bash
uv add "dbx-tools-litellm @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/litellm"
```

## Key features

- resolves a Databricks profile from `--profile`, then
  `DATABRICKS_CONFIG_PROFILE`, then the Databricks CLI's configured default;
- discovers serving endpoints from the selected workspace and caches them per
  process;
- advertises discovered endpoints and family aliases only under `dbx/*` by
  default, keeping them distinct from LiteLLM's native `databricks/*` provider;
- resolves exact or fuzzy model names with `dbx-tools-model`, refreshing the
  live catalogue once after a miss;
- restricts tool-bearing requests to endpoints classified as tool-capable;
- routes Responses-only models through LiteLLM's
  `databricks/responses/...` bridge;
- resolves Responses-only proxy calls before provider selection so LiteLLM's
  native Databricks Responses implementation receives the original body;
- optionally classifies an `auto` reasoning effort as `low`, `medium`, or
  `high` for reasoning-capable OpenAI and Claude endpoints;
- supports LiteLLM chat, embedding, synchronous/asynchronous, and streaming
  entrypoints without custom request-content rewriting.

## Run the proxy

```bash
uv run dbx-litellm --port 4000
```

The launcher listens on `127.0.0.1` by default. Pass an explicit LiteLLM
`--host` value or set `HOST` to expose it on another interface.
Pass `--profile my-workspace` to override both the environment and CLI default.

The equivalent module invocation is:

```bash
uv run python -m dbx_tools.litellm --port 4000
```

Then point an OpenAI-compatible client at `http://127.0.0.1:4000/v1`:

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"dbx/databricks-claude","messages":[{"role":"user","content":"hi"}]}'
```

The resolved profile is written to `DATABRICKS_CONFIG_PROFILE`, so endpoint
discovery and LiteLLM's delegated Databricks request use the same workspace
credentials.

## Relationship to LiteLLM

LiteLLM remains the proxy and provider implementation. It owns the
OpenAI-compatible routes, Databricks authentication and transport, parameter
mapping, streaming semantics, retries, embeddings, and Chat↔Responses
conversion.

This package supplies only the workspace-specific layer LiteLLM does not have:
deterministic profile selection, live endpoint discovery, fuzzy names, and
capability-aware routing. Request messages, content blocks, tools, and provider
options are not rewritten except when the caller explicitly requests automatic
reasoning selection.

LiteLLM 1.83 loads custom handlers from a Python file beside the config. For an
existing LiteLLM config, add `config_provider.py` next to the YAML:

```python
from dbx_tools.litellm.provider import dbx_provider
from dbx_tools.litellm.reasoning import dbx_auto_reasoning
from dbx_tools.litellm.routing import dbx_responses_router
```

Then register that adjacent shim under `dbx`:

```yaml
model_list:
  - model_name: "dbx/*"
    litellm_params:
      model: "dbx/*"
      allowed_openai_params:
        - reasoning_effort
        - thinking

litellm_settings:
  callbacks:
    - config_provider.dbx_auto_reasoning
    - config_provider.dbx_responses_router
  custom_provider_map:
    - provider: dbx
      custom_handler: config_provider.dbx_provider
```

The packaged config advertises only `dbx/*`. A consumer config can opt into
LiteLLM's native Databricks provider independently:

```yaml
model_list:
  - model_name: "databricks/*"
    litellm_params:
      model: "databricks/*"
```

Set `DATABRICKS_CONFIG_PROFILE` before starting LiteLLM to override the
Databricks CLI default when `--profile` is not available.

## Automatic reasoning effort

Automatic effort is opt-in. On Chat Completions, send
`"reasoning_effort": "auto"`:

```json
{
  "model": "claude sonnet",
  "messages": [{ "role": "user", "content": "Debug this distributed deadlock" }],
  "reasoning_effort": "auto"
}
```

On Responses, use the native reasoning shape:

```json
{
  "model": "gpt 5 codex",
  "input": "Debug this distributed deadlock",
  "reasoning": { "effort": "auto" }
}
```

The callback resolves `databricks-meta-llama-3-1-8b-instruct` against the live
catalogue as its fallback classifier preference, asks the discovered endpoint
for a score from `0.01` through `1.00`, then maps that score through the target
Databricks endpoint's inferred reasoning levels. Scores below `0.34` use `low`,
scores below `0.67` use `medium`, and higher scores use `high`. An exact `1.00` uses the
GPT-5.6 ultra tier, whose LiteLLM wire value is `xhigh`; models without that
level remain at `high`. Integer classifier output is treated as a percentage
(`73` becomes `0.73`), except `1`, which remains the maximum score.

Explicit `low`, `medium`, `high`, `xhigh`, or `thinking` values are never
overridden. Unsupported targets have `auto` removed and use their normal
provider default.

The classifier sees at most eight recent non-system turns and 6,000 characters.
Full Chat transcripts are sampled directly. Short follow-ups can recover prior
turns from `metadata.thread_id`, `metadata.conversation_id`, or
`metadata.session_id`; Responses chains are linked through
`previous_response_id`. Context and classification scores use `diskcache` with
a TTL, so retries and follow-ups avoid repeated classifier calls without
retaining an unbounded transcript.

Configuration:

- `DBX_TOOLS_LITELLM_REASONING_MODEL` overrides the classifier endpoint;
- `DBX_TOOLS_LITELLM_REASONING_CACHE_DIR` changes the disk-cache directory;
- `DBX_TOOLS_LITELLM_REASONING_CACHE_TTL_SECONDS` sets the context and result
  TTL (default: 86,400 seconds);
- `DBX_TOOLS_LITELLM_REASONING_TIMEOUT_SECONDS` sets the classifier timeout
  (default: 5 seconds).

For Claude targets, LiteLLM's Databricks transformer maps the selected
`reasoning_effort` to the backend's native extended-thinking token budget.

The one-line `dbx-access` record includes `thinking_requested=<level>` for every
request. Automatic requests also include `thinking_selected=<level>` after the
classifier maps the score through the resolved model's capabilities. The
existing `reasoning=<tokens>` field remains the number of reasoning tokens
reported by the provider, not the selected effort level.

## Runtime behavior

Endpoint discovery is lazy. The first request lists serving endpoints, later
requests reuse that catalogue, and an unresolved name triggers one refresh
before the unresolved endpoint id is delegated to Databricks. `/v1/models`
refreshes the profile's live serving endpoints and uses that discovery as the
exact model list, including endpoints such as `databricks-gpt-5-6-sol`.
LiteLLM's bundled registry supplies metadata for matching live models and is
used as a fallback only when live discovery fails. The response then appends one
basic alias for each recognized deployed family. Exact models and aliases are
advertised as `dbx/databricks-gpt-5-6-sol`, `dbx/databricks-gpt`, and similar
ids. The aliases flow through the same fuzzy resolver and do not replace exact
models. A custom config that declares `databricks/*` opts into native model ids
alongside the dbx ids.

The proxy owns one process-wide SDK client and bearer cache. A fresh cache read
returns without locking; a stale read acquires an `RLock`, checks again, and
performs one synchronous SDK authentication load. SDK background refresh is
disabled so parallel requests cannot start a second refresh path.

LiteLLM's `CustomLLM` interface has no native Responses hook. For a
Responses-only endpoint, the packaged proxy's pre-call hook changes only the
model identifier to `databricks/<resolved-endpoint>`; LiteLLM's native
Databricks Responses implementation receives the original body. Other model
families use LiteLLM's own Responses-to-Chat fallback.

## Modules

- `backend` - profile-resolved workspace client, endpoint cache, and model
  resolution;
- `models` — Responses-only endpoint routing policy;
- `provider` — LiteLLM `CustomLLM` adapter and exported `dbx_provider`
  singleton;
- `reasoning` — opt-in effort classification and TTL-backed follow-up context;
- `routing` — model-only proxy hook for native Responses-only calls;
- `cli` - profile-resolving launcher for the packaged LiteLLM proxy config.

For standalone Python endpoint resolution and invocation helpers, use
[`dbx-tools-model`](../model). For the TypeScript local proxy, use
[`@dbx-tools/cli-model-proxy`](../../js/cli/model-proxy).
