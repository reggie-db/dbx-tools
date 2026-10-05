# @dbx-tools/shared-model-gateway

Browser-safe Zod contracts and model-discovery client for
`@dbx-tools/appkit-model-gateway`.

```ts
import { createModelGatewayClient, ModelListResponseSchema } from "@dbx-tools/shared-model-gateway";

const client = createModelGatewayClient();
const response = await client.listModels({ search: "claude sonnet" });
const models = ModelListResponseSchema.parse(response);
```

Use `{ codex: true }` to request the Codex-native model catalog:

```ts
const response = await client.listModels({ codex: true });
```

The package contains no Node, AppKit, SDK, authentication, or filesystem
dependencies.
