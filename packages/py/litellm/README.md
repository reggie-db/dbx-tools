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
- marks a stable prefix of Claude requests for Anthropic prompt caching, which
  GPT endpoints get automatically on the native Responses surface;
- floors rate-limit backoff to the token-per-minute window so a retry lands in a
  fresh budget instead of amplifying the limit;
- supports LiteLLM chat, embedding, synchronous/asynchronous, and streaming
  entrypoints, rewriting request content only for the Databricks serving
  constraints described under [Request processing](#request-processing).

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
capability-aware routing. Request messages and content blocks are rewritten only
to satisfy concrete Databricks serving constraints — the ordered pipeline under
[Request processing](#request-processing) (trailing-assistant repair, JSON
nudge, Claude prompt-cache marking) and the image payload guard — or when the
caller explicitly requests automatic reasoning selection. Tools are not
rewritten.

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

## Request processing

Every delegated Chat Completions request runs through a small, ordered pipeline
(`provider._prepare_messages`) before it reaches Databricks. Each step exists to
satisfy a concrete Databricks serving constraint that an OpenAI-style client
does not know about. Order matters, because each step can change what the next
one sees:

1. **Trailing-assistant repair** (`_repair_trailing_assistant`). Databricks
   rejects a transcript whose last message is an assistant turn with "This model
   does not support assistant message prefill. The conversation must end with a
   user message." Codex hits this on retry, when a stream that disconnected
   mid-turn is resumed with its partial answer replayed as the final message.
   The repair drops trailing assistant turns (including an unanswered tool call)
   so the transcript ends where the model can continue. It never empties the
   list.
2. **JSON nudge** (`_ensure_json_mentioned`). OpenAI-family endpoints refuse
   `response_format: {"type": "json_object"}` unless the prompt itself contains
   the word "json". This is a prompt-content rule, so no parameter filtering
   satisfies it. When json mode is requested but unmentioned, the nudge appends a
   short instruction to the last non-system turn — the one role guaranteed to
   survive into `input` on the Responses bridge. This is exactly how Mem0's
   memory extraction trips the rule; the nudge fixes every client at once. Runs
   after the repair so it never appends to a turn that is then dropped.
3. **Prompt-cache marking** (`_apply_prompt_cache`, Claude only). See below.
   Runs last so its breakpoints land on boundaries the earlier steps have
   already settled.

The image **payload guard** (`payload_guard.DbxPayloadGuard`) is a separate
pre-call hook, not part of the message pipeline. Databricks rejects any request
body over 32 MiB; chat clients inline uploaded images as base64 and resend them
every turn, so a couple of photos push a long chat past the cap and every turn
then fails with an opaque 400. The guard measures the serialized request and, if
it is over target, downscales base64 images (largest first) with Pillow until it
fits, raising a clear size-named error only if it still cannot.

## Prompt caching

Caching behaviour differs by model family because the two Databricks serving
surfaces expose it differently. The proxy leaves the automatic case alone and
fills the explicit case that OpenAI-style clients never trigger.

- **GPT (native Responses):** GPT-5.4+ endpoints route through LiteLLM's
  `databricks/responses/...` bridge to the native Responses surface, which
  applies **automatic**, OpenAI-style prefix caching. No marking is needed;
  a repeated prefix reads from cache and reports `cached_tokens`. Changing
  `reasoning.effort` between turns does not evict the cache, because effort is a
  top-level parameter and not part of the cached `input` prefix.
- **Claude (emulated Responses / chat):** Databricks refuses the native
  Responses passthrough for Claude ("Responses API passthrough is not supported
  for model databricks-claude-..."), so these turns go through LiteLLM's
  Responses-to-Chat emulation onto `chat/completions`. Anthropic caching on
  Databricks is **explicit**: a request is cached only where a content block
  carries `cache_control`. OpenAI-style clients (Codex, Open WebUI) never send
  it and the emulation does not add it, so without intervention the whole
  transcript is re-billed as fresh input every turn — which repeatedly trips the
  workspace input-tokens-per-minute limit on long chats.

`_apply_prompt_cache` closes that gap for Claude targets by stamping
`cache_control: {"type": "ephemeral"}` on two rolling breakpoints: the first
system message (stable for the life of the chat) and the last stable turn (the
message before the volatile final turn, already present and cache-written on the
previous turn). Anthropic matches the longest cached prefix at each breakpoint,
so two breakpoints cache effectively the whole history except the newest turn.
The final turn is left unmarked because it is new every request and would only
ever write, never read. This is a no-op for non-Claude models and for
single-turn requests, which have no stable prefix. LiteLLM's Databricks
transformer preserves `cache_control` for Claude, so marking the blocks here is
sufficient; the endpoint honours it and returns `cache_creation_input_tokens`
and `cache_read_input_tokens`.

Databricks disables the stateful Responses store (`store` / `previous_response_id`)
workspace-wide by default, so the full transcript is re-sent every turn on both
families. Caching is what keeps the re-sent prefix from being billed and
rate-limited each time.

## Rate-limit retries

The packaged router retries rate limits five times with exponential backoff and
honors provider `Retry-After` headers. Timeouts and internal server errors get
three retries. Authentication, bad requests, and content-policy failures are not
retried.

Databricks' `REQUEST_LIMIT_EXCEEDED` is a per-minute token budget, and a retry
re-sends the whole request body. Retrying inside the same minute only adds more
tokens to an already-exceeded window and cannot succeed — the amplification that
turns one rate limit into a spiral of failed reconnects. So when the server does
not send a `Retry-After`, rate-limit backoff is floored to the rate-limit window
(`RATE_LIMIT_WINDOW_SECONDS`) so every retry lands in a fresh window rather than
piling into the current one. A server `Retry-After`, when present, is
authoritative and overrides the floor.

Streaming dbx requests apply the same bounded retry protection when a rate
limit arrives before the first response chunk. A failure after content has
already streamed is returned immediately because restarting would duplicate
partial output in the client.

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
  singleton; owns the Chat Completions message pipeline (trailing-assistant
  repair, JSON nudge, Claude prompt-cache marking) and the rate-limit-aware
  streaming retry;
- `payload_guard` — pre-call hook that downscales oversize base64 images to keep
  requests under the 32 MiB serving limit;
- `reasoning` — opt-in effort classification and TTL-backed follow-up context;
- `routing` — model-only proxy hook for native Responses-only calls;
- `access_log` — one-line per-request `dbx-access` telemetry;
- `cli` - profile-resolving launcher for the packaged LiteLLM proxy config.

For standalone Python endpoint resolution and invocation helpers, use
[`dbx-tools-model`](../model). For the TypeScript local proxy, use
[`@dbx-tools/cli-model-proxy`](../../js/cli/model-proxy).
