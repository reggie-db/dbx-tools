# @dbx-tools/shared-model

The pure, browser-safe surface of the model toolkit: the model-class taxonomy,
the serving-endpoint descriptor, the model-lookup request / ranked-result
contract (zod schemas + inferred types), and the score-driven class classifier.

No `node:*`, no `WorkspaceClient`, no I/O - safe to import from a client bundle.
A frontend validates a lookup request, types a ranked response, and buckets a
`/models` payload by class; an agent tool can adopt `ModelQuerySchema` as its
`inputSchema` directly. Live endpoint listing and fuzzy resolution live in
[`@dbx-tools/node-model`](../../node/model).

```ts
import { model, classify, type ServingEndpointSummary } from "@dbx-tools/shared-model";

const q = model.ModelQuerySchema.parse({ modelClass: "chat-fast" });
const buckets = classify.classifyEndpoints(endpoints);
```

## Modules

- `model` - `ModelClass` enum + schema, `ModelProfile`,
  `ServingEndpointSummary`, `ModelQuery`, `RankedModel` schemas/types.
- `classify` - `classifyByFamily` / `classifyEndpoints` / `versionTuple`
  (score- and family-driven class buckets).
