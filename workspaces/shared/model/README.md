# @dbx-tools/shared-model

Browser-safe model-selection contract and classifier.

Import this package when UI code, route handlers, tools, or tests need to
validate model lookup requests, type ranked model responses, or classify serving
endpoints without talking to Databricks. Live workspace listing and fuzzy
resolution live in [`@dbx-tools/model`](../../node/model).

Key features:

- Shared `ModelClass` taxonomy for chat-thinking, chat-balanced, chat-fast, and
  embedding workloads.
- Browser-safe zod schemas for lookup requests, endpoint summaries, ranked
  results, and profile metadata.
- Endpoint classifier that groups serving endpoints by score profile and family
  naming conventions.
- Version/family parsing helpers for model catalogues and tests.
- Types that match the server selection API without depending on the Databricks
  SDK.

## Validate A Model Lookup Request

```ts
import { model } from "@dbx-tools/shared-model";

const query = model.ModelQuerySchema.parse({
  search: "claude sonnet",
  modelClass: "chat-balanced",
  limit: 5,
});
```

Use `model.ModelQuerySchema` for route query/body validation and agent tool
inputs. It keeps client model pickers and backend resolution endpoints on the
same request shape.

## Type Ranked Results

```ts
import { model, type RankedModel } from "@dbx-tools/shared-model";

const ranked: RankedModel = model.RankedModelSchema.parse(response);
```

`model.ServingEndpointSummarySchema` describes the stable endpoint fields exposed
to clients: endpoint name, task, state, optional profile scores, classified
class, and embedding dimension.

## Classify Endpoint Catalogues

```ts
import { classify, model } from "@dbx-tools/shared-model";

const byClass = classify.classifyEndpoints(endpoints);
const fast = byClass[model.ModelClass.ChatFast];
```

The classifier uses Foundation Model API quality/speed/cost scores when present
and family-name heuristics when scores are missing. This is useful for client
grouping, tests, and offline catalogue analysis.

## Parse Model Families

```ts
const family = classify.classifyByFamily("databricks-claude-sonnet-4-6");
const version = classify.versionTuple("llama-3-1-70b");
```

Family parsing helps callers bucket custom lists or explain why an endpoint
landed in a class before the live workspace scores are available.

## Modules

- `model` - `ModelClass`, zod schemas, and inferred types for profiles,
  endpoint summaries, lookup requests, and ranked results.
- `classify` - family parsing, version tuple parsing, and endpoint
  classification.

Server-side selection, cache, and fuzzy endpoint matching are in
[`@dbx-tools/model`](../../node/model).
