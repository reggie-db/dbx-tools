# `dbx-tools-litellm`

Thin LiteLLM integration for Databricks Model Serving. It adds live endpoint
discovery, loose model-name resolution, and a small set of documented serving
compatibility guards, then delegates to LiteLLM's built-in Databricks provider.

Install from PyPI:

```bash
uv add dbx-tools-litellm
```

To install the current `main` branch directly from the repository instead:

```bash
uv add "dbx-tools-litellm @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/litellm"
```

## Key features

- accepts an optional `--profile` override, otherwise resolving
  `DATABRICKS_CONFIG_PROFILE`, then the one marked as the Databricks CLI
  default; a Databricks App uses its ambient service-principal environment
  without a profile;
- discovers serving endpoints from the selected workspace and caches the
  catalogue for five minutes per process;
- exposes exact endpoint ids at `/v1`;
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
`--profile` is available as an override but is not required.

List the same models `GET /v1/models` would return, without starting the proxy:

```bash
uv run dbx-litellm models
uv run dbx-litellm models --extended
uv run dbx-litellm models --output json
uv run dbx-litellm lookup gpt
```

Text output puts the display name first, followed by the exact model id.
`--extended` or `--all` adds owner, context window, and reasoning levels.
`--output json` prints the OpenAI `data` list plus the Codex `models` envelope.
`lookup` uses the same standard ranking as model resolution and prints matching
models in rank order with their scores. `lookup --output json` and
`GET /v1/models/lookup?search=<keyword>` return the same
`[{"score": ..., "modelClass": ..., "endpoint": {...}}]` ranked-model payload.

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
credentials. In a Databricks App, `DATABRICKS_HOST` selects ambient SDK
authentication and no profile value is written.

## How a request flows

The package has two paths because LiteLLM's `CustomLLM` interface handles Chat
Completions and embeddings, but does not expose a native Responses hook:

1. **Select one workspace.** An explicit `--profile` overrides
   `DATABRICKS_CONFIG_PROFILE`; when neither is present, `dbx-litellm` runs
   `databricks auth profiles --output json --skip-validate` and selects the one
   entry marked `"default": true`. It writes the result back to
   `DATABRICKS_CONFIG_PROFILE` before LiteLLM starts.
2. **Discover and resolve the model.** The first model-dependent request lazily
   calls the selected workspace's Serving Endpoints API. An exact endpoint name,
   or a loose name such as `claude sonnet` is ranked against that live catalogue. A request containing
   function tools can match only an endpoint classified as tool-capable.
3. **Choose the serving surface.** Chat-compatible endpoints stay on Chat
   Completions. Responses-only endpoints, including newer GPT endpoints that
   reject tool calls on Chat Completions, are rewritten to
   `databricks/responses/<endpoint>`. The Responses request body itself is not
   converted or reconstructed by this package.
4. **Apply opt-in reasoning.** An explicit numeric or named effort is normalized
   to a level supported by the resolved endpoint. Only the literal value `auto`
   invokes the classifier. An omitted effort is a pass-through and lets the
   model use its own default.
5. **Apply compatibility guards.** The payload hook downsizes oversized inline
   images. Delegated Chat requests repair unsupported trailing assistant turns,
   add the required JSON-mode prompt nudge when needed, and mark Claude prompt
   cache breakpoints. Function tools are never rewritten.
6. **Inject Rust-managed credentials.** `dbx-tools-databricks-auth` resolves the
   selected profile with `prefer_user_to_machine=false`, then supplies a U2M or
   M2M bearer token through its persistent check-lock-check cache. LiteLLM
   receives the explicit token and serving base URL.
7. **Delegate to LiteLLM.** LiteLLM owns HTTP transport, OpenAI parameter
   mapping, streaming, retries, embeddings, and Chat↔Responses conversion. The
   response streams back in LiteLLM's normal OpenAI-compatible shape.

In short, the package decides **which live Databricks endpoint and API surface**
to use, performs a few documented serving compatibility fixes, and then gets
out of LiteLLM's way.

## Profiles and authentication

Profile selection happens once, at proxy startup, in this order:

1. optional `dbx-litellm --profile <name>` override;
2. `DATABRICKS_CONFIG_PROFILE`;
3. ambient Databricks App authentication when `DATABRICKS_HOST` is present;
4. the profile marked `"default": true` by
   `databricks auth profiles --output json --skip-validate`;
5. the profile named `DEFAULT`;
6. the sole configured profile.

Startup fails rather than guessing when multiple unmarked, non-`DEFAULT`
profiles remain.
The same selected profile or ambient environment configures
`dbx-tools-databricks-auth` for both endpoint discovery and inference.
Endpoint discovery creates an SDK client with the current Rust-managed token,
so model names and requests use the same workspace. The token and the
workspace's `/serving-endpoints` base URL are passed directly to LiteLLM's
built-in Databricks provider.

To override the Databricks CLI default for a process, set the environment:

```bash
DATABRICKS_CONFIG_PROFILE=my-workspace uv run dbx-litellm --port 4000
```

## Model discovery and names

Models are pulled from the selected workspace's live Serving Endpoints API, not
from a static list in this package:

- discovery is lazy on the first request that needs model resolution;
- the successful endpoint catalogue is retained in memory for five minutes;
- exact endpoint names and fuzzy family names are ranked by `dbx-tools-model`;
- a miss forces one fresh endpoint listing and retries resolution once;
- tool-bearing requests filter out endpoints not classified as tool-capable;
- resolving a model also registers its native streaming capability with
  LiteLLM, preventing unknown Databricks models from being buffered as fake
  streams.

`GET /v1/models` lazily reads the same five-minute catalogue cache used by
requests and publishes each exact endpoint as `dbx/<endpoint>`.
The response preserves the OpenAI-standard `data` list and the additional Codex
`models` envelope. `dbx-litellm models` builds that payload from the same
catalogue and seed routes. `GET /v1/models/lookup` accepts every `ModelQuery`
field as a query parameter, ranks the catalogue with the same `lookup_models`
function as `dbx-litellm lookup`, and is included in the LiteLLM OpenAPI schema.
Omitting `search` returns every eligible model.
Library-only service names from `dbx-tools-model` are not projected into the
model-list HTTP or CLI response.

The packaged proxy keeps exact workspace endpoint ids in the `dbx/*` namespace
so callers can distinguish this discovery-and-routing layer from LiteLLM's
native `databricks/*` provider. Other loose names remain accepted.

## What is cached

There is no single "LiteLLM cache" in this integration. Four independent caches
serve different purposes:

| Cache                        | Storage and scope                                                                                 | Filled when                                                   | Refresh or expiry                                                                                             | Purpose                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Endpoint catalogue           | Memory, one proxy process                                                                         | First resolution or `/v1/models`                              | Five-minute TTL; forced once after a resolution miss                                                          | Avoid listing Serving Endpoints on every request                                                           |
| Databricks bearer token      | Rust credential store and process-safe profile lock                                               | First endpoint or inference request needing credentials       | Five-minute refresh buffer; U2M refreshes and M2M repeats the client-credentials grant under check-lock-check | Share valid tokens across requests and processes without duplicate refreshes                               |
| Reasoning context and scores | `diskcache`, default `~/.cache/dbx-tools/litellm`, shared by local processes using that directory | Only for `reasoning_effort: auto` or `reasoning.effort: auto` | TTL, default 86,400 seconds; bounded to 64 MiB, eight turns, and 6,000 sampled characters                     | Reuse follow-up context and avoid classifying the same sample again                                        |
| Provider prompt cache        | Databricks/model-provider managed                                                                 | Repeated prompt prefixes                                      | Provider-defined lifetime and eviction                                                                        | Reduce billed/counted repeated input tokens; GPT is automatic, Claude uses explicit breakpoints added here |

The endpoint catalogue is process memory. Databricks credentials use the Rust
package's CLI/file/memory policy and refresh locks. The reasoning cache can be
moved or assigned a shorter TTL with the environment variables
under [Automatic reasoning effort](#automatic-reasoning-effort). Prompt-cache
contents remain provider-side; this package only supplies Claude's cache markers
and reports the usage fields returned by the provider.

## Relationship to LiteLLM

LiteLLM is the proxy and provider implementation. It owns the
OpenAI-compatible routes, Databricks transport, parameter mapping, streaming
semantics, retries, embeddings, and Chat↔Responses conversion.
`dbx-tools-databricks-auth` owns authentication and passes its bearer token to
LiteLLM explicitly. The Databricks SDK uses that token only for endpoint
discovery.

This package supplies only the workspace-specific layer LiteLLM does not have:
deterministic profile selection, live endpoint discovery, fuzzy names, and
capability-aware routing. Shared family/version/model parsing and canonical
first-party service names live in `dbx-tools-model`. Request messages and
content blocks are rewritten only
to satisfy concrete Databricks serving constraints — the ordered pipeline under
[Request processing](#request-processing) (trailing-assistant repair, JSON
nudge, Claude prompt-cache marking) and the image payload guard — or when the
caller explicitly requests automatic reasoning selection. Function tools pass
through unchanged; the LiteLLM 1.96.2 namespace workaround unwraps only the
grouping object around those functions.

### Pinned compatibility

The package pins `litellm[proxy]` to 1.96.2 because its two narrow startup
patches target private LiteLLM APIs:

- non-Claude `reasoning_effort` must not enter the thinking-token helper without
  a `thinking` block;
- Responses namespace tools must be unwrapped before LiteLLM's Chat bridge,
  which still drops that wrapper in 1.96.2.

The proxy also caps FastAPI below 0.140.7. That FastAPI release removed
`get_flat_dependant`, which LiteLLM 1.96.2 imports during proxy startup. Remove
the cap after LiteLLM ships its `get_flat_params` compatibility fix. Upgrade
LiteLLM only with the full offline suite and proxy startup smoke test.

LiteLLM 1.96 loads custom handlers from a Python file beside the config. For an
existing LiteLLM config, add `config_provider.py` next to the YAML:

```python
from dbx_tools.litellm.access_log import dbx_access_logger
from dbx_tools.litellm.payload_guard import dbx_payload_guard
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
        - parallel_tool_calls

litellm_settings:
  callbacks:
    - config_provider.dbx_payload_guard
    - config_provider.dbx_auto_reasoning
    - config_provider.dbx_responses_router
    - config_provider.dbx_access_logger
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

Set `DATABRICKS_CONFIG_PROFILE` or pass `--profile` to override the Databricks
CLI default.

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
catalogue as its default classifier preference, asks the discovered endpoint
for a score from `0.01` through `1.00`, then maps that score through the target
Databricks endpoint's inferred reasoning levels. The default mapping is
`minimal` at or below `0.05` when available, `low` below `0.34`, `medium` below
`0.67`, `xhigh` at or above `0.85` when available, and otherwise `high`. An
exact `1.00` selects `max` when the endpoint exposes it. Chat Completions for
GPT-5.6 excludes `max`; the native Responses path can use the endpoint's full
set. Integer classifier output is treated as a percentage (`73` becomes
`0.73`), except `1`, which remains the maximum score.

Explicit named or numeric selectors do not invoke the classifier, but they are
normalized through the resolved endpoint's supported levels. A native
`thinking` object takes precedence and is passed through after removing the
competing effort selector. An omitted or `default` selector is a true
pass-through. Unsupported targets have `auto` removed and use their provider
default.

The classifier sees at most eight recent non-system turns and 6,000 characters.
Full Chat transcripts are sampled directly. Short follow-ups can recover prior
turns from `metadata.thread_id`, `metadata.conversation_id`, or
`metadata.session_id`; successful Responses calls index that bounded context by
response id so a later `previous_response_id` can recover it. Scores are keyed
by a SHA-256 hash of the complete bounded sample. Context and scores use
`diskcache` with the same TTL, so retries and identical follow-ups avoid repeated
classifier calls without retaining an unbounded transcript. A classifier
timeout, malformed score, or empty sample falls back to `0.50`.

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

Each inference access line includes `requested_model=<client value>`,
`model=<resolved endpoint>`, and `ip=<requesting address>`. The IP is the first
address in `X-Forwarded-For` when present, then the direct client address.
Non-streaming Chat Completions and Responses JSON use the same distinction:
`model` is the resolved Databricks endpoint and `requestedModel` is the value
sent by the client.
`GET /v1/models` emits its own access line with the requesting IP, HTTP status,
and a family summary such as `8 models (3 claude, 2 gpt, 3 other)`.

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
   The repair drops trailing assistant text turns so the transcript ends where
   the model can continue. It preserves trailing `tool_calls` /
   `function_call`, which the client may be about to answer, and never empties
   the list.
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

## Responses routing

LiteLLM's `CustomLLM` interface has no native Responses hook. The pre-call
router therefore resolves the model before LiteLLM selects a provider. For a
Responses-only endpoint it changes only the model identifier to the native
Databricks Responses route and injects the cached `api_key` and `api_base`;
LiteLLM's Databricks Responses implementation receives the original body.
Chat-compatible families use LiteLLM's normal Responses-to-Chat fallback.

The same policy also protects Chat Completions callers: GPT family versions
known to reject function tools on Chat Completions are delegated through
LiteLLM's `databricks/responses/...` bridge. This keeps clients on one
OpenAI-compatible proxy URL while selecting the Databricks surface that the
resolved endpoint actually supports.

## Validate

Run the offline package checks:

```sh
uv run pytest packages/py/model packages/py/litellm -q
uv run ruff check packages/py/model packages/py/litellm
uv run dbx-litellm --help
uv run dbx-litellm models --help
uv run dbx-litellm lookup --help
```

Then start the proxy and exercise live discovery before inference:

```sh
uv run dbx-litellm --port 4000
curl -fsS http://127.0.0.1:4000/health/readiness
curl -fsS http://127.0.0.1:4000/v1/models
curl -fsS 'http://127.0.0.1:4000/v1/models/lookup?search=gpt'
```

Release validation also covers non-streaming Chat, streaming Chat, Responses,
function-call replay, namespace tools, and embeddings. An embedding request
must preserve an exact embedding endpoint id rather than fuzzy-routing it to a
chat endpoint.

## Modules

- `backend` - profile-resolved workspace client, endpoint cache, and model
  resolution;
- `credentials` - process-wide Databricks credential caching and refresh;
- `config_provider` - generated LiteLLM proxy configuration;
- `models` — Responses-only endpoint routing policy;
- `models_api` - OpenAI-compatible model-list endpoint behavior;
- `provider` — LiteLLM `CustomLLM` adapter and exported `dbx_provider`
  singleton; owns the Chat Completions message pipeline (trailing-assistant
  repair, JSON nudge, Claude prompt-cache marking) and the rate-limit-aware
  streaming retry;
- `payload_guard` — pre-call hook that downscales oversize base64 images to keep
  requests under the 32 MiB serving limit;
- `reasoning` — opt-in effort classification and TTL-backed follow-up context;
- `routing` — model-only proxy hook for native Responses-only calls;
- `access_log` — one-line per-request `dbx-access` telemetry;
- `patches` - version-specific LiteLLM startup guards;
- `cli` - profile-resolving launcher plus complete cached model inspection.

For standalone Python endpoint resolution and invocation helpers, use
[`dbx-tools-model`](../model).
[`dbx-tools-graphiti`](../graphiti) launches this proxy in managed mode and
supplies its private host and port to upstream Graphiti.
