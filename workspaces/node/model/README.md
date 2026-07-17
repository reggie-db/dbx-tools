# @dbx-tools/node-model

Workspace-aware model selection for Databricks Model Serving: list a workspace's
`/serving-endpoints` (cached via AppKit's `CacheManager`), fuzzy-match loose
names like `"claude sonnet"` to real endpoint ids, rank endpoints by capability
class, and resolve a single usable model id with an offline fallback floor.

The server-side package (it holds a `WorkspaceClient` and AppKit's cache).
Browser consumers want the pure [`@dbx-tools/shared-model`](../../shared/model)
surface, which holds the taxonomy + classifier.

```ts
import { resolve } from "@dbx-tools/node-model";

// Hold a WorkspaceClient + host, get a usable model id in one call:
const { modelId, source } = await resolve.selectModel(client, host, {
  explicit: "claude sonnet",
});
```

## Modules

- `serving` - cached `/serving-endpoints` listing + `fuse.js` fuzzy resolve +
  embedding-dimension probe.
- `resolve` - `rankModels` / `resolveModel` / `selectModel` / `searchModels`.
- `classes` - chat-class ordering, `parseModelClass`, `classesAtOrBelow`.
- `fallback` - offline static-floor model list per class.

`@databricks/appkit` is a runtime dep (its `CacheManager` backs the listing).
