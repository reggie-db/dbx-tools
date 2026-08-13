# @dbx-tools/shared-search

Browser-safe schemas and extension types for AppKit-compatible AI Search
providers.

Import this package when a UI, Mastra tool schema, server route, or test needs
to validate the same search payloads that
[`@dbx-tools/search`](../../node/search) reads and writes.

Key features:

- Shared `SearchRequest` / `SearchResult` contract with `{ id, score, fields }`
  hits, so an autocomplete box, a docs lookup, and a Mastra tool speak one shape.
- `SearchMode` (`hybrid` / `vector` / `keyword`) plus
  `toAiSearchQueryType()` for the AppKit query vocabulary.
- `UniversalSearchRequest` for federated search across several indexes at once.
- `SearchDocument` / `UpsertResult` for adding and updating direct-access index
  contents.
- `SearchIndexInfo` / `SearchClientConfig` for the boot-time index catalogue a
  search box reads with no server round-trip.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints.

## Validate A Search Request

```ts
import { search, type SearchRequest } from "@dbx-tools/shared-search";

const request: SearchRequest = search.searchRequestSchema.parse({
  query: "reset my password",
  index: "main.support.docs",
  limit: 5,
  mode: "hybrid",
  filter: { locale: "en", category: ["billing", "support"] },
});
```

## Validate Search Results

```ts
const result = search.searchResultSchema.parse(await response.json());
for (const hit of result.hits) {
  console.log(hit.score, hit.id, hit.fields.title);
}
```

`searchHitSchema` returns the requested columns under `fields`, keyed by column
name, plus the primary-key `id` and a relevance `score`. A federated hit also
carries the `index` it came from.

## Read The Index Catalogue

```ts
const config = search.searchClientConfigSchema.parse(
  await fetch("/api/search/indexes").then((r) => r.json()),
);
```

`searchClientConfigSchema` is the extension catalogue for universal search.
Single-index UI queries read native `aiSearch` client config instead.

## Module

- `search` - `searchModeSchema`, `searchRequestSchema`, `searchHitSchema`,
  `searchResultSchema`, `universalSearchRequestSchema`, `searchDocumentSchema`,
  `upsertResultSchema`, `searchIndexInfoSchema`, `searchClientConfigSchema`, and
  `toAiSearchQueryType`,
  the flat inferred types (`SearchMode`, `SearchRequest`, `SearchHit`,
  `SearchResult`, `UniversalSearchRequest`, `SearchDocument`, `UpsertResult`,
  `SearchIndexInfo`, `SearchClientConfig`).

Runtime search, index management, the Mastra tools, and the AppKit plugin live
in [`@dbx-tools/search`](../../node/search). The React search box lives in
[`@dbx-tools/ui-search`](../../ui/search).
