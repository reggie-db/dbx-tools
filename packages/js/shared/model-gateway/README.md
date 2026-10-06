# @dbx-tools/shared-model-gateway

Discover the models exposed by a dbx-tools model gateway from browser, edge, or
shared application code. The package validates successful and error responses
at the network boundary and provides the protocol contracts needed to build
model pickers without importing Node or AppKit runtime code.

## List Available Models

```ts
import { createModelGatewayClient } from "@dbx-tools/shared-model-gateway";

const client = createModelGatewayClient();
const response = await client.listModels({ search: "claude sonnet" });

for (const model of response.data) {
  console.log(model.id);
}
```

In a browser, the client uses the active origin. Supply `baseUrl` in tests,
server rendering, or any runtime without `globalThis.location`:

```ts
const client = createModelGatewayClient({
  baseUrl: "http://127.0.0.1:4000/",
});
```

## Request A Codex Catalogue

Use the Codex catalogue when a client needs Codex-specific model metadata and
reasoning controls:

```ts
const response = await client.listModels({ codex: true });
```

Pass an `AbortSignal` to cancel model discovery. HTTP failures throw
`ModelGatewayClientError`, which includes the status code and a validated gateway
error response when one was returned.

## Validate Gateway Payloads

Use the exported Zod schemas when another transport owns the HTTP request:

```ts
import { ModelListResponseSchema } from "@dbx-tools/shared-model-gateway";

const models = ModelListResponseSchema.parse(await response.json());
```

The `models` module covers OpenAI, Codex, Anthropic, embedding, and error
payloads. The `contracts` module covers model capabilities and deterministic
route-selection inputs and results.

## Configure The Gateway

`ModelGatewayOptionsSchema` owns server defaults and validation. The derived
`ModelGatewayCliOptionsSchema` adds `runtimeInfo` and requires a non-zero port
for foreground and service commands:

```ts
import {
  ModelGatewayOptionsSchema,
  resolveModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway/options";

const options = resolveModelGatewayOptions({
  host: "localhost",
  port: 4400,
  bodyLimit: "100mb",
});

ModelGatewayOptionsSchema.parse(options);
```

## Package API

- `client` creates the model-discovery client and typed HTTP errors.
- `models` validates public model, embedding, and error payloads.
- `contracts` validates shared routing and capability values.
- `options` validates shared server and CLI configuration.
