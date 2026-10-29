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

Web-search and custom-tool requests use a direct route only when the discovered
model advertises the required capability. OpenAI model-list
`capabilities.web_search` and Codex `supports_search_tool` use that same
discovered value.

## Configure Codex

`GET /v1/models` includes Codex metadata when the request carries
`Originator: codex`. Codex slugs prefer fully qualified Databricks model service
names.

Point a Codex provider at:

```text
http://127.0.0.1:4000/v1
```

Use `wire_api = "responses"` and `supports_websockets = false`.

## Configure model policy

`model` and `modelClass` set the default selection. `preferSystemModels` selects
`system.ai.*` AI Gateway services for non-exact eligible requests. An exact
serving endpoint or `system.ai.*` name still wins.

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
- `transport` sends requests to Databricks model APIs.
