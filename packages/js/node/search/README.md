# @dbx-tools/search

Extensions for AppKit's beta AI Search plugin: agent tools, federated search,
index lifecycle helpers, and an AppKit-compatible Lakebase full-text provider.

Use native AppKit `aiSearch` for
[Databricks AI Search](https://docs.databricks.com/aws/en/ai-search/ai-search)
queries. Add this package when an agent needs `search` /
`universal_search`, an app needs to create, sync, or seed indexes, or a
deployment needs the same AppKit query contract backed by PostgreSQL full-text
search instead of Vector Search.

**Key features:**

- Vector Search reads delegate to AppKit `aiSearch`, which owns OBO execution,
  caching, reranking, pagination, route validation, and response decoding.
- `lakebaseAiSearch()` implements the same `aiSearch` alias, route,
  client-config, and `SearchResponse` contract with PostgreSQL `tsvector`.
- Agent tools for both Mastra (`searchTool()` etc.) and AppKit agents (through
  the extension plugin's `ToolProvider`): `search` and `universal_search`
  reads, plus provider-aware write tools. Lakebase exposes `add_documents`;
  native Vector Search can also expose `create_index` and `sync_index`.
- AppKit-compatible query routes under `/api/ai-search/:alias`; extension
  routes under `/api/search` cover universal search and optional lifecycle
  operations.
- Sensible-default config that infers almost everything: name a default index
  (or set `DATABRICKS_VECTOR_SEARCH_INDEX`) and the columns, page size, mode,
  aliases, and route path all have defaults you can override when you need to go
  deeper.
- OBO for Vector Search comes from native AppKit `aiSearch`. Lakebase full-text
  search uses the sibling `lakebase` plugin's service-principal pool.
- Filters use AppKit's scalar/array shape: `{ column: valueOrValues }`.
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
- An explicit **Lakebase full-text provider**: register `lakebaseAiSearch`
  instead of native `aiSearch` to serve the same aliases, query routes, filters,
  and result shape from a Postgres `tsvector` index.

## Why Use This Over Native AppKit

Do not use this package instead of native AppKit for ordinary Vector Search
queries. Register `aiSearch` from `@databricks/appkit/beta`.

Use this package for capabilities AppKit does not ship: agent tool providers,
federated fan-out, index lifecycle and seeding, reusable result components, or
the Lakebase full-text implementation of the AppKit AI Search contract.

## Quick Start

```ts
import { createApp, server } from "@databricks/appkit";
import { aiSearch } from "@databricks/appkit/beta";
import { plugin as searchPlugin, tool as searchToolApi } from "@dbx-tools/search";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Answer from the docs; use `search` to find them.",
  tools: () => ({ search: searchToolApi.searchTool() }),
});

await createApp({
  plugins: [
    server(),
    aiSearch({
      indexes: {
        docs: {
          indexName: "main.support.docs",
          columns: ["id", "title", "url", "body"],
        },
      },
    }),
    searchPlugin.search({
      index: "main.support.docs",
      indexes: [{ name: "main.support.docs", alias: "docs" }],
    }),
    mastraPlugin.mastra({ agents: support }),
  ],
});
```

Use Lakebase full-text search without changing the AppKit UI hook:

```ts
import { lakebase } from "@databricks/appkit";
import { lakebaseAiSearch } from "@dbx-tools/search";

createApp({
  plugins: [
    lakebase(),
    lakebaseAiSearch({
      indexes: {
        docs: {
          indexName: "docs",
          columns: ["id", "title", "body"],
          queryType: "full_text",
        },
      },
    }),
  ],
});
```

## Manage Indexes

`SearchClient` is the lifecycle client; query execution requires the registered
AppKit-compatible provider. Create and maintain indexes with the same
infer-everything ergonomics. A Delta
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

### Lakebase full-text provider

`lakebaseAiSearch()` is an AppKit `aiSearch` provider backed by a Postgres
full-text index. It provisions one table per alias (a generated `tsvector`
column with a GIN index), seeds configured documents, and answers queries with
a prefix `to_tsquery` + `ts_rank`. The pool comes from the native `lakebase`
plugin's service-principal config, so database authentication is not
re-implemented.

Queries are compiled from the search box rather than handed to
`websearch_to_tsquery`, which is too literal for type-ahead in two ways:

- **Punctuation.** Postgres indexes `racetrac-store-intelligence` as the
  compound lexeme _plus_ its parts, but compiles a hyphenated **query** to the
  compound alone - so `store-intelligence` matches nothing while
  `store intelligence` matches everything. The query is split on punctuation,
  so both spellings (and `.` / `_` in a table reference) behave the same.
- **Prefixes.** Every term is matched as a prefix, so `intel` reaches
  `intelligence` and `store intel` finds `racetrac-store-intelligence`.

All terms must match. When none do, search relaxes instead of returning an
empty box: any single term counts, plus a substring pass that catches a
fragment which is not a prefix (`telligence`). The substring pass cannot use
the GIN index, so it only runs after the indexed pass finds nothing.

The provider returns AppKit's `SearchResponse` and mounts the same
`/api/ai-search/:alias` query surface. AppKit UI's `useAiSearchQuery` and
`@dbx-tools/ui-search` work without a backend-specific client:

```ts
import { createApp, lakebase } from "@databricks/appkit";
import { lakebaseAiSearch } from "@dbx-tools/search";

createApp({
  plugins: [
    lakebase(),
    lakebaseAiSearch({
      indexes: {
        docs: {
          indexName: "docs",
          queryType: "full_text",
          columns: ["id", "title", "text"],
          documents: [{ id: "1", title: "Overview", text: "Search over Postgres full-text." }],
        },
      },
    }),
  ],
});
```

Register either native `aiSearch` for Vector Search or `lakebaseAiSearch` for
Postgres full text. Both use the registered plugin name `aiSearch`, so they are
alternatives and must not be registered together.

## Configuration

All fields are optional. Precedence is plugin config, then environment, then a
default.

| Config           | Environment                                      | Default                 | Purpose                                                  |
| ---------------- | ------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| `index`          | `SEARCH_INDEX`, `DATABRICKS_VECTOR_SEARCH_INDEX` | –                       | Default index (name or alias).                           |
| `indexes`        | –                                                | `[index]`               | Indexes known for aliases, universal search, and the UI. |
| `endpoint`       | `SEARCH_ENDPOINT`                                | –                       | Vector Search endpoint (only needed to create an index). |
| `columns`        | `SEARCH_COLUMNS`                                 | index's columns         | Default columns per hit.                                 |
| `pageSize`       | `SEARCH_PAGE_SIZE`                               | `10`                    | Default hits per search.                                 |
| `mode`           | `SEARCH_MODE`                                    | `hybrid`                | `hybrid` / `vector` / `keyword`.                         |
| `embeddingModel` | `SEARCH_EMBEDDING_MODEL`                         | best embedding endpoint | Embedding endpoint for index creation.                   |
| `timeoutMs`      | `SEARCH_TIMEOUT_MS`                              | `30000`                 | Per-call timeout.                                        |
| `allowWrite`     | `SEARCH_WRITE`                                   | `false`                 | Enable provider-supported write tools and routes.        |
| `ensureOnSetup`  | –                                                | –                       | Provision and seed a native Vector Search index at boot. |

## Modules

- `client` - `SearchClient`, `SearchIndex`, and the Vector Search lifecycle
  (`createIndex` / `ensureIndex` / `syncIndex` / `deleteIndex` / `listIndexes`
  / `ensureEndpoint`), plus provider-backed federated reads.
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
- `native` - adapter from an AppKit-compatible `aiSearch` provider to the
  extension tools and universal-search client.
- `lakebase-plugin` - `lakebaseAiSearch`, the AppKit-compatible PostgreSQL
  full-text provider.
- `lakebase` - `LakebaseSearchBackend`, the provider's `tsvector` runtime.
- `query` - `toDocumentArray`, shared by write routes and tools.
- `runtime` - `getSearchRuntime` / `resetSearchRuntime` (the shared client).
- `schema` - the tool descriptions and re-exported request schemas.

Browser-safe schemas live in
[`@dbx-tools/shared-search`](../../shared/search); the React search box
lives in [`@dbx-tools/ui-search`](../../ui/search). Model resolution reuses
[`@dbx-tools/model`](../model).
