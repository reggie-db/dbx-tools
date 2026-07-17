# @dbx-tools/model

Workspace-aware Databricks Model Serving selection.

Import this package when server-side code needs to turn a loose model request
like `"claude sonnet"` or `"chat-fast"` into a concrete serving endpoint in the
current workspace. It lists `/serving-endpoints`, caches and enriches the
catalogue, classifies endpoints by capability, fuzzy-matches names, and falls
back to a small static floor when the live catalogue is unavailable.

Browser-safe request/result schemas and endpoint classification types live in
[`@dbx-tools/shared-model`](../../shared/model).

Key features:

- Lists Databricks Model Serving endpoints through the SDK and normalizes them
  into a stable summary shape.
- Classifies endpoints into chat-thinking, chat-balanced, chat-fast, and
  embedding classes using Foundation Model API scores and family heuristics.
- Resolves loose user input such as `"sonnet"` or `"chat fast"` to a concrete
  endpoint id.
- Supports class ceilings so callers can ask for a capability band without
  accidentally escalating to a larger model.
- Caches enriched catalogues per workspace host through AppKit cache utilities.
- Provides a small static fallback floor for local tools and degraded workspace
  access.

## Why Not Just AppKit Serving?

Native AppKit's Model Serving plugin is the right choice when you already know
the endpoint alias you want. It gives you authenticated invoke/stream routes,
OBO execution, generated endpoint types, request-body filtering, and frontend
hooks.

Use this package before or beside that layer when the hard part is choosing the
endpoint:

- resolve loose human input such as `"sonnet"` or `"fast"` against the live
  workspace catalogue;
- group endpoints into capability classes like `chat-thinking`, `chat-balanced`,
  `chat-fast`, and `embedding`;
- enforce class ceilings so a caller can degrade to smaller models without
  escalating to a larger one;
- build model pickers and debug routes from a cached, enriched endpoint list;
- keep local agents and CLIs working with a static fallback when catalogue
  access is unavailable.

## Select One Model

```ts
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { resolve } from "@dbx-tools/model";

const client = new WorkspaceClient({});
const host = String(await client.config.getHost());

const selected = await resolve.selectModel(client, host, {
  explicit: "claude sonnet",
});

console.log(selected.modelId, selected.source);
```

`selectModel()` is the high-level helper for agents and CLIs. It reads the live
catalogue, applies fuzzy matching when an explicit string is present, then
returns a single `modelId` plus a source label explaining why that endpoint won.

The `source` label is useful for logs and debug UIs. It distinguishes explicit
matches from class-based selection, environment defaults, and fallback results,
so operators can tell whether a request used the intended model policy.

## Build A Model Picker

```ts
import { resolve } from "@dbx-tools/model";

const ranked = await resolve.searchModels(client, host, {
  search: "opus",
  modelClass: "chat-thinking",
  limit: 5,
});
```

Use `searchModels()` for UI pickers and debug routes. It returns ranked models
with match scores and endpoint summaries, using the same fuzzy threshold and
class ceiling logic as `selectModel()`.

## Work With A Held Catalogue

When you already have endpoint summaries, use the pure resolver functions from
`resolve` and `serving` without another workspace call:

```ts
import { resolve, serving } from "@dbx-tools/model";

const endpoints = await serving.listServingEndpoints(client, host);
const ranked = resolve.rankModels(endpoints, { search: "sonnet", limit: 3 });
const picked = resolve.resolveModel(endpoints, {
  explicit: "claude sonnet",
  modelClass: "chat-balanced",
});
```

The class acts as a ceiling. `chat-balanced` may fall back to `chat-fast`, but
will not escalate to `chat-thinking`. Embedding endpoints are considered only
when the requested class is `embedding`.

## List And Cache Serving Endpoints

```ts
import { serving } from "@dbx-tools/model";

const endpoints = await serving.listServingEndpoints(client, host, {
  ttlMs: 5 * 60_000,
});

const raw = await serving.listServingEndpointsUncached(client);
await serving.clearServingEndpointsCache(host);
```

`listServingEndpoints()` uses AppKit's `CacheManager`, enriches endpoints with
classification and embedding dimensions, and keys the cache by workspace host.
`listServingEndpointsUncached()` is useful for simple scripts that only need the
SDK response and do not want a cache dependency.

## Fuzzy Resolve Endpoint Names

```ts
const matches = serving.searchServingEndpoints("claude sonnet", endpoints, {
  threshold: 0.35,
});

const endpointName = serving.resolveModelId("sonnet", endpoints);
```

Fuzzy matching is intentionally a server concern because it depends on the live
workspace catalogue and may re-list on misses. Disable it in callers that require
exact endpoint ids.

## Use Static Fallbacks

```ts
import { classes, fallback } from "@dbx-tools/model";
import { model } from "@dbx-tools/shared-model";

const cls = classes.parseModelClass("chat-fast") ?? model.ModelClass.ChatFast;
const modelId = fallback.modelForClass(cls);
```

The fallback floor gives agents and local scripts a stable answer when a
workspace cannot list endpoints. Prefer live catalogue resolution for production
policy decisions; fallbacks are a last resort.

## Modules

- `resolve` - high-level `selectModel`, ranked search, and catalogue-held
  resolver functions.
- `serving` - Databricks serving-endpoint listing, cache management, fuzzy
  search, and endpoint-id resolution.
- `classes` - model-class parsing, ordering, and class-ceiling helpers.
- `fallback` - static fallback model ids per class.

The AppKit-Mastra integration uses this package through
[`@dbx-tools/appkit-mastra`](../appkit-mastra); the local OpenAI-compatible
gateway uses it through [`@dbx-tools/model-proxy`](../../cli/model-proxy).
