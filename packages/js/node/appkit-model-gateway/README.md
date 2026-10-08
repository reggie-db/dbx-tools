# @dbx-tools/appkit-model-gateway

Give OpenAI-, Anthropic-, and Codex-compatible clients one endpoint for the
models available in a Databricks workspace. The AppKit plugin discovers the
workspace catalogue, exposes familiar model APIs, and chooses a compatible
Databricks route for each request.

## Register The AppKit Plugin

```ts
import { createApp, server } from "@databricks/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway";

await createApp({
  plugins: [modelGateway(), server()],
});
```

AppKit mounts the plugin routes under `/api/model-gateway/v1/*`. The
`@dbx-tools/cli/model-gateway` package owns foreground server construction and
standard root compatibility paths.

## Connect A Client

Use the standalone CLI when a tool expects an OpenAI-compatible base URL:

```sh
dbx model-gateway --profile PROFILE --port 4000
```

Configure the client with `http://127.0.0.1:4000/v1`. For an embedded AppKit
route, use the app origin plus `/api/model-gateway/v1`.

The gateway supports:

- OpenAI Responses and Chat Completions;
- Anthropic Messages;
- OpenAI-compatible embeddings;
- Codex model discovery and Responses traffic.

## Discover Models

```ts
import { createModelGatewayClient } from "@dbx-tools/shared-model-gateway";

const client = createModelGatewayClient({ baseUrl: "http://127.0.0.1:4000/" });
const models = await client.listModels({ search: "sonnet" });
```

Use `{ codex: true }` when a Codex client needs its native catalogue shape.

## Request Compatibility

Requests stay on a native streaming path when the selected model supports the
client protocol. When protocols differ, the gateway translates the request and
response while preserving streaming and cancellation behavior.

The gateway rejects stateful Responses options it cannot preserve, including
`previous_response_id`, `store: true`, and `background: true`.

## Configure Codex

`GET /v1/models` includes Codex metadata when the request carries
`Originator: codex`. Codex slugs prefer fully qualified Databricks model service
names.

Point a Codex provider at:

```text
http://127.0.0.1:4000/v1
```

Use `wire_api = "responses"` and `supports_websockets = false`.

## Package API

- `modelGateway()` registers the AppKit plugin.
- `gateway` handles protocol-neutral gateway requests.
- `registry` discovers and resolves workspace models.
- `router` selects a compatible route from model capabilities.
- `transport` sends requests to Databricks model APIs.
