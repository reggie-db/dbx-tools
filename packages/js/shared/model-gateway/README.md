# @dbx-tools/shared-model-gateway

Discover models exposed by a dbx-tools model gateway from browser, edge, or
shared application code. The package validates success and error responses at
the network boundary and provides model-picker contracts without importing Node
or Databricks AppKit runtime code.

## List available models

```ts
import { createModelGatewayClient } from "@dbx-tools/shared-model-gateway";

const client = createModelGatewayClient();
const response = await client.listModels({ search: "claude sonnet" });
const modelIds = "data" in response ? response.data.map((model) => model.id) : [];
```

The catalogue includes the virtual `smart_router` chat model only when the
gateway's memoized Databricks Smart Router probe succeeds. Its
`capabilities.smart_router` field distinguishes it from concrete endpoints.
Successful probes expire after five minutes by default and are also refreshed
hourly in the background. A failed routed request invalidates a positive probe
immediately so later model-list responses stop advertising the virtual model.

In a browser, the client uses the active origin. Supply `baseUrl` in tests,
server rendering, or any runtime without `globalThis.location`:

```ts
const client = createModelGatewayClient({
  baseUrl: "http://127.0.0.1:4000/",
});
```

## Request a Codex catalog

Use the Codex catalog when a client needs Codex-specific model metadata and
reasoning controls:

```ts
const response = await client.listModels({ codex: true });
```

Pass an `AbortSignal` to cancel model discovery. HTTP failures throw
`ModelGatewayClientError`, which includes the status code and a validated gateway
error response when one was returned.

## Validate gateway payloads

Use the exported Zod schemas with another HTTP transport:

```ts
import { ModelListResponseSchema } from "@dbx-tools/shared-model-gateway";

const models = ModelListResponseSchema.parse(await response.json());
```

The `models` module covers OpenAI, Codex, Anthropic, embedding, and error
payloads. The `contracts` module covers model capabilities and deterministic
route-selection inputs and results.

## Configure gateway options

`ModelGatewayOptionsSchema` defines server defaults and validation. The derived
`ModelGatewayCliOptionsSchema` adds `runtimeInfo` and requires a non-zero port
for foreground and service commands:

```ts
import {
  ModelGatewayOptionsSchema,
  resolveModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway/options";

const options = resolveModelGatewayOptions({
  smartRouter: "auto",
  smartRouterTimeoutMs: 10000,
  listen: "localhost:4400",
  modelClass: "chat-balanced",
  preferSystemModels: true,
  bodyLimit: "100mb",
});

ModelGatewayOptionsSchema.parse(options);
```

`ModelSelectionOptionsSchema` defines the mutually exclusive `model` and
`modelClass` fields shared by model-gateway and Genie Code callers. Omit both to
select the best available chat model. `preferSystemModels` defaults to `false`.
When enabled, non-exact requests use `system.ai.*` services instead of workspace
serving endpoints.

The `smartRouter` module exports the canonical `smart_router` id, validated
`routes:select` contracts, and response-header names used to observe the
selected concrete model and `task_v3` profile.

## Runtime boundary

The discovery client performs HTTP requests to `GET /v1/models`. The schemas and
option helpers don't start a gateway, resolve Databricks credentials, or invoke
models. Use
[@dbx-tools/appkit-model-gateway](../../node/appkit-model-gateway) for AppKit
gateway transport and [@dbx-tools/model](../../node/model) for server-side
model discovery and selection.

## Package exports

- `client`: creates the model-discovery client and typed HTTP errors.
- `models`: validates public model, embedding, and error payloads.
- `contracts`: validates shared routing and capability values.
- `options`: validates shared server and CLI configuration.
- `smartRouter`: owns the virtual model id, wire schemas, and observation headers.
