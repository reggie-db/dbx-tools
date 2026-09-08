# `dbx-tools-litellm`

Thin routing and discovery around LiteLLM's native Databricks provider.

The package resolves live Databricks endpoints, injects Rust-managed
credentials and the correct Unity Gateway URL, and publishes model discovery
routes. LiteLLM owns request conversion, transport, tools, streaming, and
retries.

## Key features

- Uses `litellm[proxy]` 1.99.0 and Python 3.11 or newer.
- Resolves exact or fuzzy model names against the selected workspace.
- Routes Chat, Responses, and embeddings through LiteLLM's native Databricks
  and OpenAI providers.
- Selects `/ai-gateway/codex/v1` for OpenAI GPT Responses,
  `/ai-gateway/mlflow/v1` for other foundation model services and embeddings,
  and `/serving-endpoints` for custom endpoints.
- Exposes live `/v1/models` and package-specific `/lookup` routes without
  LiteLLM's hardcoded model catalogue.
- Preserves native Databricks Responses tools and hosted-tool output.
- Learns optional parameters rejected by each model, retries the active call,
  and caches the result for one day.
- Records requested model, resolved model, requesting IP, latency, token usage,
  cache usage, and streaming mode.

## Install

```bash
uv add dbx-tools-litellm
```

The package supports Python 3.11 through 3.13.

## Run

```bash
uv run dbx-litellm --port 4000
```

The proxy listens on `127.0.0.1` by default. Any additional arguments are
forwarded to LiteLLM.

An explicit profile is optional:

```bash
uv run dbx-litellm --profile my-workspace --port 4000
```

`dbx_tools.databricks_auth` owns profile selection, U2M, M2M, and PAT authentication,
storage, locking, and token refresh. The proxy reads the resolved profile and
host from that package rather than invoking the Databricks CLI itself.
Explicit PAT profiles are supported. Automatic profile resolution ignores PAT
configuration inside a Databricks App so ambient app credentials remain in use.

## Request routing

The model routing hook changes only LiteLLM routing fields:

1. Resolve the requested model against the five-minute live endpoint cache.
2. Select the endpoint's `system.ai.*` model-service identity when available.
3. Set LiteLLM's native `databricks` provider and the matching Databricks base
   URL.
4. Inject the Rust-managed bearer token.
5. Forward a Codex `originator` header when present.

The routing hook leaves messages, tools, images, and provider parameters
unchanged. LiteLLM's native bridge converts Responses requests and Chat
responses for model services without native OpenAI Responses support. Bridged
requests use LiteLLM's native parameter dropping and omit reasoning only when
the cached endpoint record exposes no reasoning efforts.

Foundation model Chat and embedding calls use the OpenAI-compatible Unity
Gateway:

```text
<workspace>/ai-gateway/mlflow/v1/chat/completions
<workspace>/ai-gateway/mlflow/v1/embeddings
```

Codex OpenAI GPT Responses use:

```text
<workspace>/ai-gateway/codex/v1/responses
```

Custom serving endpoints retain LiteLLM's native Databricks serving URL.

## Models

`GET /v1/models` is the standard OpenAI model-list route. It is built only from
the live workspace catalogue and excludes deprecated endpoints.

Standard OpenAI clients receive the `data` envelope with exact endpoint IDs.
Requests whose `originator` begins with `codex` also receive the Codex `models`
extension. Codex entries use `databricks/system.ai.*` model-service IDs and
include:

- `supported_reasoning_levels` from endpoint metadata, using the required empty
  list when the endpoint exposes none;
- `default_reasoning_level`, preferring `medium`;
- visibility, priority, shell, truncation, and base-instruction metadata
  required by Codex.

OpenAI GPT model services use LiteLLM's native OpenAI Responses provider
against the Codex-compatible gateway. Other text-model families use LiteLLM's
native Responses-to-Chat bridge against the MLflow-compatible gateway. The
Codex catalogue uses an exclusion policy for Claude, Gemini, Inkling, and
embedding families, so newly recognized text-model families are eligible by
default.

List the same catalogue without starting the proxy:

```bash
uv run dbx-litellm models
uv run dbx-litellm models --extended
uv run dbx-litellm models --output json
```

## Lookup

`GET /lookup` ranks the live catalogue using `dbx-tools-model`. It exposes the
`ModelQuery` fields as query parameters and returns complete `RankedModel`
records. An omitted search returns every eligible model.

```bash
curl 'http://127.0.0.1:4000/lookup?search=gpt&limit=5'
uv run dbx-litellm lookup gpt
uv run dbx-litellm lookup gpt --output json
```

## Codex

Point Codex at the local proxy:

```toml
[model_providers.dbx]
name = "dbx-tools LiteLLM"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = false
```

Codex reads `/v1/models`, selects a `databricks/system.ai.*` model, and sends
its `originator` header with Responses requests.

## Databricks Responses tools

Native GPT Responses preserve `function`, `custom`, `apply_patch`, `shell`,
`image_generation`, `mcp`, and `web_search`, plus `tool_choice`,
`parallel_tool_calls`, `max_tool_calls`, and `include`.

OpenAI models use `{"type":"web_search"}`. Gemini web search uses
`google_search` through Chat or the Gemini API. Claude web search requires an
MCP search server.

Responses-only hosted tools are not available on the Chat bridge. LiteLLM
drops those unsupported parameters while preserving function tools accepted by
the Chat model.

## Adaptive parameter support

Model-specific Open Responses support is not present in the serving-endpoint
API. The proxy therefore learns from structured gateway rejections. When a
model rejects an optional top-level parameter, the HTTP transport extracts the
field name, retries without it, and caches the rejection by gateway route and
resolved model for one day. The cache expires so newly enabled model
capabilities are tried again.
Required protocol fields such as `model`, `input`, `messages`, and `stream` are
never removed. When a replayed function-call item uses its `call_` value as the
item `id`, the transport preserves `call_id`, removes the invalid item `id`, and
retries after the gateway reports the `fc_` namespace requirement.

## Response annotations and access logs

Non-streaming Chat and Responses JSON includes:

- `requestedModel`: the value supplied by the client;
- `model`: the resolved Databricks endpoint or model service;
- `requestEndpoint`: the exact upstream URL.

The `dbx-access` logger writes one structured line per request to stderr. It
includes model identity, requesting IP, timing, token counts, cache counts, and
whether streaming was native or emulated.

## Modules

- `backend` - live catalogue cache and fuzzy resolution.
- `capabilities` - adaptive parameter cache and HTTP retry transport.
- `credentials` - Rust-backed credentials and Databricks base URLs.
- `routing` - native provider and originator routing.
- `models` - dynamic native-streaming registration.
- `models_api` - `/v1/models`, `/lookup`, and response annotations.
- `originator` - Codex originator extraction and forwarding.
- `access_log` - request telemetry.
- `cli` - proxy launcher and model inspection commands.
