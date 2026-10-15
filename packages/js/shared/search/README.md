# @dbx-tools/shared-search

Validate Databricks AI Search requests, results, index catalogs, and document
writes in browser and server code. It defines the browser-safe extension
contracts shared by [@dbx-tools/search](../../node/search), Mastra tools, and
[@dbx-tools/ui/search](../../ui/appkit).

## Quick start

```ts
import { searchSchemas } from "@dbx-tools/shared-search";

const request = searchSchemas.searchRequestSchema.parse({
  query: "reset my password",
  index: "main.support.docs",
  limit: 5,
});
```

The schemas cover:

- Shared `SearchRequest` / `SearchResult` contract with `{ id, score, fields }`
  hits, so an autocomplete box, a docs lookup, and a Mastra tool speak one shape.
- `SearchMode` (`hybrid` / `vector` / `keyword`) plus
  `toAiSearchQueryType()` for the AppKit query vocabulary.
- `UniversalSearchRequest` for federated search across several indexes at once.
- `SearchDocument` / `UpsertResult` for adding and updating direct-access index
  contents.
- `SearchIndexInfo` / `SearchClientConfig` for the boot-time index catalog a
  search box reads with no server round-trip.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints.

## Validate request options

```ts
import { searchSchemas, type SearchRequest } from "@dbx-tools/shared-search";

const request: SearchRequest = searchSchemas.searchRequestSchema.parse({
  query: "reset my password",
  index: "main.support.docs",
  limit: 5,
  mode: "hybrid",
  filter: { locale: "en", category: ["billing", "support"] },
});
```

## Validate search results

```ts
import { searchSchemas } from "@dbx-tools/shared-search";

const response = await fetch("/api/ai-search/docs/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "reset my password", limit: 5 }),
});
if (!response.ok) throw new Error(`Search failed with ${response.status}`);
const result = searchSchemas.searchResultSchema.parse(await response.json());
const titles = result.hits.map((hit) => hit.fields.title);
```

`searchHitSchema` returns the requested columns under `fields`, keyed by column
name, plus the primary-key `id` and a relevance `score`. A federated hit also
carries the `index` it came from.

## Read the index catalog

```ts
import { searchSchemas } from "@dbx-tools/shared-search";

const config = searchSchemas.searchClientConfigSchema.parse(
  await fetch("/api/search/indexes").then((r) => r.json()),
);
```

`searchClientConfigSchema` validates the extension catalog used for universal
search. Single-index UI queries read AppKit's published `aiSearch` client
configuration instead.

## Runtime boundary

This package doesn't query indexes, read Databricks credentials, or choose a
search backend. Use [@dbx-tools/search](../../node/search) for runtime search,
index management, Mastra tools, and the AppKit plugin. Use
[@dbx-tools/ui/search](../../ui/appkit) for React controls.

## Package exports

- `searchSchemas`: `searchModeSchema`, `searchRequestSchema`, `searchHitSchema`,
  `searchResultSchema`, `universalSearchRequestSchema`, `searchDocumentSchema`,
  `upsertResultSchema`, `searchIndexInfoSchema`, `searchClientConfigSchema`, and
  `toAiSearchQueryType`, and
  the flat inferred types (`SearchMode`, `SearchRequest`, `SearchHit`,
  `SearchResult`, `UniversalSearchRequest`, `SearchDocument`, `UpsertResult`,
  `SearchIndexInfo`, `SearchClientConfig`).
