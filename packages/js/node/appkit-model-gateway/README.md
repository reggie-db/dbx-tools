# @dbx-tools/appkit-model-gateway

Expose models in a Databricks workspace through OpenAI Responses, OpenAI Chat
Completions, Anthropic Messages, embeddings, and Codex-compatible APIs. The
gateway discovers the workspace catalogue and selects a compatible Databricks
route for each request.

## Choose embedded, foreground, or service mode

Register the AppKit plugin when model routes belong to an existing application.
Run `dbx model-gateway` for a foreground loopback endpoint used by local tools.
Use `dbx model-gateway service install` when that local endpoint must continue
after the terminal closes.

## Register the AppKit plugin

```ts
import { createApp, server } from "@databricks/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway";

await createApp({
  plugins: [modelGateway(), server()],
});
```

AppKit mounts the plugin routes under `/api/model-gateway/v1/*`. The
[@dbx-tools/cli](../../cli/dbx-tools) provides foreground server construction,
current-user service management, and standard root compatibility paths.

## Connect a client

Use the standalone CLI when a tool expects an OpenAI-compatible base URL:

```sh
dbx model-gateway --profile PROFILE --listen tcp://127.0.0.1:4000
```

The system-model preference routes non-exact Responses requests, including
Codex traffic, through `system.ai.*` AI Gateway services instead of workspace
serving endpoints. Codex model slugs follow the same choice. An exact endpoint
id or `system.ai.*` name always wins.

Configure the client with
[http://127.0.0.1:4000/v1](http://127.0.0.1:4000/v1). For an embedded AppKit
route, use the app origin plus `/api/model-gateway/v1`.

The gateway supports:

- OpenAI Responses and Chat Completions.
- Anthropic Messages.
- OpenAI-compatible embeddings.
- Codex model discovery and Responses traffic.

## Use Smart Router

Select the virtual `smart-router` model from any supported chat protocol:

```json
{
  "model": "smart-router",
  "input": "Refactor the authorization layer across the repository"
}
```

Before returning `GET /v1/models`, the gateway makes one memoized
`task_v3` capability request to Databricks
`/ai-gateway/routing/v1/routes:select`. The virtual model is listed only when
that request succeeds for the active identity and live `system.ai.*`
candidates. Positive probes are shared for five minutes and concurrent probes
coalesce into one request. Stale values are returned immediately while
`@dbx-tools/cache` `refreshAfterWrite` coalesces one access-triggered background
refresh. An explicit inference request skips this synthetic preflight because
its real route selection is already the availability check.

For inference, the gateway extracts bounded task context from Responses input,
Chat Completions or Anthropic messages, plain text, or generic JSON objects. It
excludes credentials, tool schemas, and tool arguments. OpenAI-shaped requests
use the `codex` Smart Router harness policy; Anthropic Messages uses `claude`.
The selected route must match one of the offered, protocol-compatible live
models. There is no local tier classifier or fallback selector.

The same `smart-router` id works with Responses, Chat Completions, Anthropic
Messages, and Codex-compatible Responses traffic. Embeddings require an
explicit model. Explicit concrete models and model-class headers continue to
win.

Smart Router selections are pinned for the logical user turn. The default store
uses AppKit `CacheManager`, so configured Lakebase/PostgreSQL persistence is
reused across app replicas. Supply `smartRouterStore` to use another storage
implementation with the same `get`/`set` contract, including a SQLite-backed
adapter. Only the selected model and bounded route metadata are stored; prompts
and responses are not.

This state is a TTL route pin, not conversation history. The gateway does not
read Mastra `PostgresStore`: supported chat requests already carry the portable
transcript, and coupling routing to Mastra would exclude other chat clients.
AppKit cache persistence is also preferable to a gateway-owned file or a second
expiring table because it already handles process-local reuse, project-scoped
disk fallback, and configured Lakebase/PostgreSQL storage. A consumer can still
inject a different store when its deployment needs another backend.

Response headers expose the selected concrete model, returned route model,
harness, cache source, and any `task_v3` task tier, served tier, or profiler
status without rewriting the upstream response body's model identity.

Select a model without starting the server by passing a JSON or text file, or
`-` for standard input:

```sh
dbx model-gateway --profile PROFILE --select-model-from request.json
```

## Discover models

```ts
import { createModelGatewayClient } from "@dbx-tools/shared-model-gateway";

const client = createModelGatewayClient({ baseUrl: "http://127.0.0.1:4000/" });
const models = await client.listModels({ search: "sonnet" });
```

Use `{ codex: true }` when a Codex client needs its native catalogue shape.

## Request compatibility

Requests stay on a native streaming path when the selected model supports the
client protocol. When protocols differ, the gateway translates the request and
response through Vercel AI SDK messages while preserving text, function tools,
reasoning, usage, finish reasons, streaming, and cancellation. Embeddings use a
direct Databricks embeddings route and are not translated.

The gateway rejects stateful Responses options it cannot preserve, including
`previous_response_id`, `store: true`, and `background: true`.

Explicit `temperature: null` is omitted. For Databricks models with published
models.dev metadata, unsupported temperatures are omitted and supported values
are clamped to Databricks' `0..2` range. Unknown custom endpoints keep finite
numeric temperatures unchanged.

See [request parameter translation](../../../../docs/model-gateway.md#understand-request-parameter-translation)
for the temperature and reasoning flows.

Web-search and custom-tool requests use a direct route only when the discovered
model advertises the required capability. OpenAI model-list
`capabilities.web_search` and Codex `supports_search_tool` use that same
discovered value.

## Configure Codex

`GET /v1/models` includes Codex metadata when the request carries
`Originator: codex`. Codex slugs prefer fully qualified Databricks model service
names.

Codex merges provider models with its bundled catalogue. The gateway reserves a
separate provider priority range so bundled recommendations remain together,
then places Smart Router before the Databricks model list. Codex-specific model
ordering puts GPT models first and newer family versions before older versions.
Databricks GPT labels include the `Databricks` prefix so they remain distinct
from bundled GPT models after Codex applies its compact label formatting.

Point a Codex provider at:

```text
http://127.0.0.1:4000/v1
```

Use `wire_api = "responses"` and `supports_websockets = false`.

## Configure model policy

`model` and `modelClass` set the default selection. `preferSystemModels` selects
`system.ai.*` AI Gateway services for non-exact eligible requests. An exact
serving endpoint or `system.ai.*` name still wins.

Smart Router defaults to `smartRouter: "auto"` and is advertised only after its
capability probe succeeds. Set `smartRouter: "true"` to make model discovery
fail when the router is unavailable, or `smartRouter: "false"` to disable it.
Configure `smartRouterTimeoutMs`,
`smartRouterContextTokenBudget`, `smartRouterProbeTtlMs`,
`smartRouterProbeRefreshIntervalMs`, and `smartRouterRouteTtlSeconds` to tune
transport, context, request-driven probe expiry, background probe refresh, and
turn-pinning behavior. A failed real selection immediately invalidates the
positive probe.

Use `overrides` when workspace metadata must be corrected for a specific model.
For example, disable an advertised capability that the selected gateway route
cannot use:

```ts
import { modelGateway } from "@dbx-tools/appkit-model-gateway";

modelGateway({
  overrides: [
    {
      model: "databricks-gpt-example",
      capabilities: { webSearch: false },
    },
  ],
});
```

Overrides affect routing and the OpenAI and Codex model catalogues.

## Package API

- `modelGateway()` registers the AppKit plugin.
- `gateway` handles protocol-neutral gateway requests.
- `registry` discovers and resolves workspace models.
- `router` selects a compatible route from model capabilities.
- `smartRouter` builds task context, probes availability, and calls `task_v3`.
- `transport` sends requests to Databricks model APIs.
