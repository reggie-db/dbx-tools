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

- requires an explicit Databricks CLI profile and never silently uses the SDK
  default;
- discovers serving endpoints from the selected workspace and caches them per
  process;
- resolves exact or fuzzy model names with `dbx-tools-model`, refreshing the
  live catalogue once after a miss;
- restricts tool-bearing requests to endpoints classified as tool-capable;
- routes Responses-only models through LiteLLM's
  `databricks/responses/...` bridge;
- resolves Responses-only proxy calls before provider selection so LiteLLM's
  native Databricks Responses implementation receives the original body;
- supports LiteLLM chat, embedding, synchronous/asynchronous, and streaming
  entrypoints without custom request-content rewriting.

## Run the proxy

```bash
uv run dbx-litellm --profile my-workspace --port 4000
```

The launcher listens on `127.0.0.1` by default. Pass an explicit LiteLLM
`--host` value or set `HOST` to expose it on another interface.

The equivalent module invocation is:

```bash
uv run python -m dbx_tools.litellm --profile my-workspace --port 4000
```

Then point an OpenAI-compatible client at `http://127.0.0.1:4000/v1`:

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude sonnet","messages":[{"role":"user","content":"hi"}]}'
```

`--profile` also pins `DATABRICKS_CONFIG_PROFILE`, so endpoint discovery and
LiteLLM's delegated Databricks request use the same workspace credentials.

## Relationship to LiteLLM

LiteLLM remains the proxy and provider implementation. It owns the
OpenAI-compatible routes, Databricks authentication and transport, parameter
mapping, streaming semantics, retries, embeddings, and Chat↔Responses
conversion.

This package supplies only the workspace-specific layer LiteLLM does not have:
explicit profile selection, live endpoint discovery, fuzzy names, and
capability-aware routing. Request messages, content blocks, tools, reasoning
fields, and provider options are not rewritten here.

LiteLLM 1.83 loads custom handlers from a Python file beside the config. For an
existing LiteLLM config, add `config_provider.py` next to the YAML:

```python
from dbx_tools.litellm.provider import dbx_provider
from dbx_tools.litellm.routing import dbx_responses_router
```

Then register that adjacent shim under `dbx`:

```yaml
model_list:
  - model_name: "databricks/*"
    litellm_params:
      model: "databricks/*"
  - model_name: "*"
    litellm_params:
      model: "dbx/*"
      allowed_openai_params:
        - reasoning_effort
        - thinking

litellm_settings:
  callbacks:
    - config_provider.dbx_responses_router
  custom_provider_map:
    - provider: dbx
      custom_handler: config_provider.dbx_provider
```

Set `DBX_LITELLM_PROFILE` or `DATABRICKS_CONFIG_PROFILE` before starting
LiteLLM. If both are set, they must name the same profile.

## Runtime behavior

Endpoint discovery is lazy. The first request lists serving endpoints, later
requests reuse that catalogue, and an unresolved name triggers one refresh
before the unresolved endpoint id is delegated to Databricks. `/v1/models`
remains LiteLLM's configured model list; it is not replaced with the live
Databricks endpoint catalogue.

LiteLLM's `CustomLLM` interface has no native Responses hook. For a
Responses-only endpoint, the packaged proxy's pre-call hook changes only the
model identifier to `databricks/<resolved-endpoint>`; LiteLLM's native
Databricks Responses implementation receives the original body. Other model
families use LiteLLM's own Responses-to-Chat fallback.

## Modules

- `backend` — explicit-profile workspace client, endpoint cache, and model
  resolution;
- `models` — Responses-only endpoint routing policy;
- `provider` — LiteLLM `CustomLLM` adapter and exported `dbx_provider`
  singleton;
- `routing` — model-only proxy hook for native Responses-only calls;
- `cli` — profile-pinned launcher for the packaged LiteLLM proxy config.

For standalone Python endpoint resolution and invocation helpers, use
[`dbx-tools-model`](../model). For the TypeScript local proxy, use
[`@dbx-tools/cli-model-proxy`](../../js/cli/model-proxy).
