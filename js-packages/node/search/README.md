# @dbx-tools/search

A Meilisearch-style shortcut over Databricks AI Search (Vector Search): a search
client, agent tools, and an AppKit plugin.

Import this package when an AppKit or Mastra backend needs to search a
[Databricks AI Search](https://docs.databricks.com/aws/en/ai-search/ai-search)
index - for autocomplete, docs lookup, RAG retrieval, or a universal search box
across several indexes. It wraps the low-level SDK
(`vectorSearchIndexes.queryIndex({ index_name, columns, query_text, query_type,
num_results, filters_json })` and its columnar response) behind an ergonomic
client, and ships the agent tools, HTTP routes, and boot config a search UI
needs - so search is one plugin and, in the simple case, zero config.

**Key features:**

- A small, Meilisearch-shaped client: `client.index("catalog.schema.docs")`,
  `index.search(query)`, `index.autocomplete(prefix)`, `index.addDocuments(...)`,
  and `client.universalSearch(query)` to fan a query across many indexes and
  merge the hits.
- Hybrid matching by default (semantic similarity fused with BM25 keyword
  ranking), with `vector` and `keyword` modes when you want one or the other.
- Agent tools for both Mastra (`searchTool()` etc.) and AppKit agents (through
  the plugin's `ToolProvider`): `search` and `universal_search` reads, plus the
  opt-in write tools `add_documents`, `create_index`, and `sync_index`.
- HTTP routes under `/api/search` a browser search box calls directly:
  `POST /` (search), `POST /universal` (federated), `GET /indexes` (catalogue),
  and, when writes are enabled, `POST /documents` (upsert),
  `POST /index` (create), and `POST /index/sync` (refresh).
- A `clientConfig()` payload so a UI knows the indexes, default, and page size at
  boot with no round-trip (read it with `usePluginClientConfig("search")`).
- Sensible-default config that infers almost everything: name a default index
  (or set `DATABRICKS_VECTOR_SEARCH_INDEX`) and the columns, page size, mode,
  aliases, and route path all have defaults you can override when you need to go
  deeper.
- OBO throughout: routes wrap in `asUser(req)` and the client resolves the
  execution-context workspace client, so search runs as the requesting user and
  Unity Catalog ACLs apply.
- Filters as plain `{ column: value }` (or `{ column: { ">=": n } }`) compiled to
  the index `filters_json` for you; the columnar response is unpacked into
  `{ id, score, fields }` hits.
- Embedding-model resolution for index creation reuses
  [`@dbx-tools/model`](../model): a loose name fuzzy-matches the live catalogue,
  or the best embedding endpoint is chosen automatically.
- Index lifecycle without the ceremony: `createIndex` / `ensureIndex` (Delta
  Sync from a source table, self-managed direct-access with a dimension, or a
  managed direct-access index that embeds a text column - no Delta table or
  warehouse), `provision` (ensure + seed in one idempotent call), `syncIndex`,
  `deleteIndex`, `listIndexes`, and `ensureEndpoint` - each inferring the
  endpoint, embedding model, primary key, and columns from sensible defaults.
- Wire up a real index on boot with `ensureOnSetup`: the plugin provisions the
  endpoint + index and seeds documents in the background using the app's SDK
  auth (env or `DATABRICKS_CONFIG_PROFILE`), so a fresh deployment is searchable
  with no manual setup.
- A **Lakebase full-text fallback**: when no Vector Search endpoint is
  configured but the AppKit `lakebase` plugin is registered, search transparently
  runs on a Postgres `tsvector` index instead - same `provision` / `search` /
  `add_documents` calls, same `{ id, score, fields }` hits, so tools, routes, and
  the UI can't tell which backend answered. No endpoint, no embeddings, no Delta
  table - just a table the plugin creates and seeds on boot.

## Why Use This Over Native AppKit

AppKit exposes Vector Search as a resource type and a low-level serving surface,
but nothing that makes a search box or an agent tool a one-liner. Use this
package when you want search to be a drop-in: the friendly client hides the
verbose `queryIndex` request and columnar response, the plugin gives agents a
`search` tool and a browser a `POST /api/search` route in one registration,
universal search fans across indexes, and the config infers everything from a
single index name. Reach for the raw SDK when you need index lifecycle
operations this package does not wrap.

## Quick Start

```ts
import { createApp, server } from "@databricks/appkit";
import { plugin as searchPlugin, tool as searchToolModule } from "@dbx-tools/search";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Answer from the docs; use `search` to find them.",
  tools: () => ({ search: searchToolModule.searchTool() }),
});

await createApp({
  plugins: [
    server(),
    // zero-config: reads DATABRICKS_VECTOR_SEARCH_INDEX / SEARCH_INDEX
    searchPlugin.search(),
    mastraPlugin.mastra({ agents: support }),
  ],
});
```

Going deeper:

```ts
searchPlugin.search({
  index: "main.support.docs",
  indexes: [
    "main.support.docs",
    { name: "main.catalog.products", alias: "products", columns: ["name", "sku", "price"] },
  ],
  columns: ["title", "url", "body"],
  mode: "hybrid",
  pageSize: 10,
  allowWrite: false,
});
```

## Use The Client Directly

```ts
import { createSearchClient } from "@dbx-tools/search";

const client = createSearchClient();
const docs = client.index("main.support.docs");

const { hits } = await docs.search("reset my password", { limit: 5 });
const suggestions = await docs.autocomplete("rese");
const everywhere = await client.universalSearch("invoice error 402");

await docs.addDocuments([{ id: "42", title: "Reset", body: "…" }]);
```

## Manage Indexes

Create and maintain indexes with the same infer-everything ergonomics. A Delta
Sync index computes embeddings from a source Delta table and stays synced; the
embedding model, endpoint, primary key (`id`), and text column
(`text`/`content`/`body`) are all inferred when omitted.

```ts
const client = createSearchClient();

// Ensure the Vector Search endpoint exists (creates a STANDARD one if not).
await client.ensureEndpoint("my-vs-endpoint", { wait: true });

// Delta Sync index from a Delta table (embeddings computed by Databricks).
await client.ensureIndex("main.support.docs", {
  endpoint: "my-vs-endpoint",
  sourceTable: "main.support.docs_source",
  // embeddingModel / primaryKey / embeddingSourceColumn inferred when omitted
});

// Trigger a sync, then later delete.
await client.syncIndex("main.support.docs");
await client.deleteIndex("main.support.docs");

// Managed direct-access index (the lightest REAL index): Databricks embeds a
// text column on write AND query, so no Delta table, no warehouse, no vectors.
await client.createIndex("main.support.docs", {
  endpoint: "my-vs-endpoint",
  // managed by default when no embeddingDimension is given
});
await client
  .index("main.support.docs")
  .addDocuments([{ id: "1", text: "AI Search finds the most relevant documents for a query." }]);

// Self-managed direct-access index you write vectors to yourself.
await client.createIndex("main.support.vectors", { embeddingDimension: 1024 });
await client.index("main.support.vectors").addDocuments([{ id: "1", embedding: [/* … */] }]);

// One call to make an index real AND seeded (idempotent - safe every boot).
await client.provision("main.support.docs", {
  endpoint: "my-vs-endpoint",
  seed: [{ id: "1", text: "Databricks AI Search overview", url: "https://…" }],
});
```

The `SearchIndex` handle mirrors these: `index.ensure(opts)`, `index.sync()`,
`index.delete()`, `index.info()`.

When the plugin's write surface is on (`search({ allowWrite: true })` or
`SEARCH_WRITE=true`), agents get the same lifecycle as tools: `create_index`
provisions an index with everything inferred (pass a `sourceTable` for the
common Delta Sync case, or an `embeddingDimension` for a direct-access index),
and `sync_index` refreshes a Delta Sync index from its source table. They are
gated because they change infrastructure, so grant them only where a caller
should be able to set up or refresh indexes.

### Provision a real index on boot

`ensureOnSetup` makes the plugin wire up a real index when the app starts, using
the boot-time SDK auth (env vars or a `DATABRICKS_CONFIG_PROFILE`). It ensures
the endpoint + index exist and seeds documents only when the index is empty, all
in the background so a slow first-time endpoint build never blocks the server.
The default is a managed direct-access index, so the seed rows are plain
objects and search-by-text works immediately - no Delta table, no warehouse.

```ts
search({
  index: "main.support.docs",
  endpoint: "my-vs-endpoint",
  ensureOnSetup: {
    embeddingModel: "databricks-gte-large-en", // optional; best embedding endpoint otherwise
    documents: [
      { id: "1", title: "Overview", text: "AI Search finds relevant docs.", url: "https://…" },
      { id: "2", title: "Indexes", text: "Delta Sync vs. direct access." },
    ],
    // schema inferred from the first row; primaryKey/textColumn default to id/text
  },
});
```

Idempotent: later boots see the endpoint, index, and rows already present and do
nothing. Point `ensureOnSetup.sourceTable` at a Delta table to provision a Delta
Sync index instead of a managed direct-access one.

### Lakebase full-text fallback

When you have **no** Vector Search endpoint configured but the AppKit `lakebase`
plugin is registered, the plugin transparently falls back to a Postgres
full-text index. It provisions one table per index (a generated `tsvector`
column with a GIN index), seeds the same `ensureOnSetup.documents`, and answers
queries with a prefix `to_tsquery` + `ts_rank`. The pool is built from the
`lakebase` plugin's service-principal config exactly like
[`@dbx-tools/appkit-mastra`](../appkit-mastra) builds its memory pool - no auth
is re-implemented.

Queries are compiled from the search box rather than handed to
`websearch_to_tsquery`, which is too literal for type-ahead in two ways:

- **Punctuation.** Postgres indexes `racetrac-store-intelligence` as the
  compound lexeme _plus_ its parts, but compiles a hyphenated **query** to the
  compound alone - so `store-intelligence` matches nothing while
  `store intelligence` matches everything. The query is split on punctuation,
  so both spellings (and `.` / `_` in a table reference) behave the same.
- **Prefixes.** Every term is matched as a prefix, so `intel` reaches
  `intelligence` and `store intel` finds `racetrac-store-intelligence`.

All terms must match. When none do, the search relaxes instead of returning an
empty box: any single term counts, plus a substring pass that catches a
fragment which is not a prefix (`telligence`). The substring pass cannot use
the GIN index, so it only runs after the indexed pass finds nothing.

The point is parity: the client returns the identical `SearchResult` /
`SearchHit` (`{ id, score, fields }`) / `UpsertResult` shapes, so the agent
tools, the `/api/search` routes, and the React search box behave the same
whichever backend is active. Register `lakebase()`, omit `endpoint`, and search
works with no Vector Search infrastructure:

```ts
import { createApp, lakebase } from "@databricks/appkit";
import { plugin as searchPlugin } from "@dbx-tools/search";

const { search } = searchPlugin;

createApp({
  plugins: [
    lakebase(), // register it and search uses Postgres full-text
    search({
      // no `endpoint` -> Lakebase full-text fallback
      index: "docs",
      ensureOnSetup: {
        documents: [{ id: "1", title: "Overview", text: "Search over Postgres full-text." }],
      },
    }),
  ],
});
```

Selection is automatic and logged at boot (`backend: "vector-search"` vs
`"lakebase"`). Configure an `endpoint` and Vector Search wins; drop it and the
Lakebase fallback takes over.

## Configuration

All fields are optional. Precedence is plugin config, then environment, then a
default.

| Config           | Environment                                      | Default                 | Purpose                                                                                    |
| ---------------- | ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| `index`          | `SEARCH_INDEX`, `DATABRICKS_VECTOR_SEARCH_INDEX` | –                       | Default index (name or alias).                                                             |
| `indexes`        | –                                                | `[index]`               | Indexes known for aliases, universal search, and the UI.                                   |
| `endpoint`       | `SEARCH_ENDPOINT`                                | –                       | Vector Search endpoint (only needed to create an index).                                   |
| `columns`        | `SEARCH_COLUMNS`                                 | index's columns         | Default columns per hit.                                                                   |
| `pageSize`       | `SEARCH_PAGE_SIZE`                               | `10`                    | Default hits per search.                                                                   |
| `mode`           | `SEARCH_MODE`                                    | `hybrid`                | `hybrid` / `vector` / `keyword`.                                                           |
| `embeddingModel` | `SEARCH_EMBEDDING_MODEL`                         | best embedding endpoint | Embedding endpoint for index creation.                                                     |
| `timeoutMs`      | `SEARCH_TIMEOUT_MS`                              | `30000`                 | Per-call timeout.                                                                          |
| `allowWrite`     | `SEARCH_WRITE`                                   | `false`                 | Enable the write tools (`add_documents` / `create_index` / `sync_index`) and their routes. |
| `ensureOnSetup`  | –                                                | –                       | Provision the endpoint + index and seed documents at boot (background).                    |

## Modules

- `client` - `SearchClient`, `SearchIndex`, `createSearchClient`, the search
  methods, and the index lifecycle (`createIndex` / `ensureIndex` / `syncIndex`
  / `deleteIndex` / `listIndexes` / `ensureEndpoint`), plus the `SearchOptions` /
  `UniversalSearchOptions` / `IndexInfo` / `CreateIndexOptions` /
  `EnsureEndpointOptions` types.
- `plugin` - `SearchPlugin` and the `search()` factory (`ToolProvider`,
  routes, `clientConfig`, `exports`).
- `tool` - the `searchTool()`, `universalSearchTool()`, `addDocumentsTool()`,
  `createIndexTool()`, and `syncIndexTool()` Mastra factories.
- `index-tools` - `toCreateIndexOptions`, the shared mapping from the
  `create_index` wire request onto `SearchClient.createIndex` options (used by
  both the Mastra tool and the plugin route).
- `config` - `resolveSearchConfig`, `resolveIndexName`, `SEARCH_CONFIG_SCHEMA`,
  the config env constants, and the `SearchPluginConfig` /
  `ResolvedSearchConfig` types.
- `query` - `toQueryType`, `compileFilter`, `toHits`, `toRequestColumns`,
  `toDocumentArray` (contract ↔ serving-API translation).
- `lakebase` - `LakebaseSearchBackend`, the Postgres full-text FALLBACK used
  when no Vector Search endpoint is configured (provision + seed + `tsvector`
  search, same hit shape as Vector Search).
- `runtime` - `getSearchRuntime` / `resetSearchRuntime` (the shared client).
- `schema` - the tool descriptions and re-exported request schemas.

Browser-safe schemas live in
[`@dbx-tools/shared-search`](../../shared/search); the React search box
lives in [`@dbx-tools/ui-search`](../../ui/search). Model resolution reuses
[`@dbx-tools/model`](../model).
