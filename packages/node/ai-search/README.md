# @dbx-tools/ai-search

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
- HTTP routes under `/api/ai-search` a browser search box calls directly:
  `POST /` (search), `POST /universal` (federated), `GET /indexes` (catalogue),
  and, when writes are enabled, `POST /documents` (upsert),
  `POST /index` (create), and `POST /index/sync` (refresh).
- A `clientConfig()` payload so a UI knows the indexes, default, and page size at
  boot with no round-trip (read it with `usePluginClientConfig("aiSearch")`).
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
  Sync from a source table, or direct-access with a dimension), `syncIndex`,
  `deleteIndex`, `listIndexes`, and `ensureEndpoint` - each inferring the
  endpoint, embedding model, primary key, and columns from sensible defaults.

## Why Use This Over Native AppKit

AppKit exposes Vector Search as a resource type and a low-level serving surface,
but nothing that makes a search box or an agent tool a one-liner. Use this
package when you want search to be a drop-in: the friendly client hides the
verbose `queryIndex` request and columnar response, the plugin gives agents a
`search` tool and a browser a `POST /api/ai-search` route in one registration,
universal search fans across indexes, and the config infers everything from a
single index name. Reach for the raw SDK when you need index lifecycle
operations this package does not wrap.

## Quick Start

```ts
import { createApp, server } from "@databricks/appkit";
import { plugin as aiSearchPlugin, tool as searchToolModule } from "@dbx-tools/ai-search";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Answer from the docs; use `search` to find them.",
  tools: () => ({ search: searchToolModule.searchTool() }),
});

await createApp({
  plugins: [
    server(),
    // zero-config: reads DATABRICKS_VECTOR_SEARCH_INDEX / AI_SEARCH_INDEX
    aiSearchPlugin.aiSearch(),
    mastraPlugin.mastra({ agents: support }),
  ],
});
```

Going deeper:

```ts
aiSearchPlugin.aiSearch({
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
import { createSearchClient } from "@dbx-tools/ai-search";

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

// Direct-access index you write vectors to yourself (no source table).
await client.createIndex("main.support.vectors", { embeddingDimension: 1024 });
await client.index("main.support.vectors").addDocuments([{ id: "1", embedding: [/* … */] }]);
```

The `SearchIndex` handle mirrors these: `index.ensure(opts)`, `index.sync()`,
`index.delete()`, `index.info()`.

When the plugin's write surface is on (`aiSearch({ allowWrite: true })` or
`AI_SEARCH_WRITE=true`), agents get the same lifecycle as tools: `create_index`
provisions an index with everything inferred (pass a `sourceTable` for the
common Delta Sync case, or an `embeddingDimension` for a direct-access index),
and `sync_index` refreshes a Delta Sync index from its source table. They are
gated because they change infrastructure, so grant them only where a caller
should be able to set up or refresh indexes.

## Configuration

All fields are optional. Precedence is plugin config, then environment, then a
default.

| Config           | Environment                                         | Default                 | Purpose                                                                                    |
| ---------------- | --------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `index`          | `AI_SEARCH_INDEX`, `DATABRICKS_VECTOR_SEARCH_INDEX` | –                       | Default index (name or alias).                                                             |
| `indexes`        | –                                                   | `[index]`               | Indexes known for aliases, universal search, and the UI.                                   |
| `endpoint`       | `AI_SEARCH_ENDPOINT`                                | –                       | Vector Search endpoint (only needed to create an index).                                   |
| `columns`        | `AI_SEARCH_COLUMNS`                                 | index's columns         | Default columns per hit.                                                                   |
| `pageSize`       | `AI_SEARCH_PAGE_SIZE`                               | `10`                    | Default hits per search.                                                                   |
| `mode`           | `AI_SEARCH_MODE`                                    | `hybrid`                | `hybrid` / `vector` / `keyword`.                                                           |
| `embeddingModel` | `AI_SEARCH_EMBEDDING_MODEL`                         | best embedding endpoint | Embedding endpoint for index creation.                                                     |
| `timeoutMs`      | `AI_SEARCH_TIMEOUT_MS`                              | `30000`                 | Per-call timeout.                                                                          |
| `allowWrite`     | `AI_SEARCH_WRITE`                                   | `false`                 | Enable the write tools (`add_documents` / `create_index` / `sync_index`) and their routes. |

## Modules

- `client` - `SearchClient`, `SearchIndex`, `createSearchClient`, the search
  methods, and the index lifecycle (`createIndex` / `ensureIndex` / `syncIndex`
  / `deleteIndex` / `listIndexes` / `ensureEndpoint`), plus the `SearchOptions` /
  `UniversalSearchOptions` / `IndexInfo` / `CreateIndexOptions` /
  `EnsureEndpointOptions` types.
- `plugin` - `AiSearchPlugin` and the `aiSearch()` factory (`ToolProvider`,
  routes, `clientConfig`, `exports`).
- `tool` - the `searchTool()`, `universalSearchTool()`, `addDocumentsTool()`,
  `createIndexTool()`, and `syncIndexTool()` Mastra factories.
- `index-tools` - `toCreateIndexOptions`, the shared mapping from the
  `create_index` wire request onto `SearchClient.createIndex` options (used by
  both the Mastra tool and the plugin route).
- `config` - `resolveAiSearchConfig`, `resolveIndexName`, `AI_SEARCH_CONFIG_SCHEMA`,
  the config env constants, and the `AiSearchPluginConfig` /
  `ResolvedAiSearchConfig` types.
- `query` - `toQueryType`, `compileFilter`, `toHits`, `toRequestColumns`,
  `toDocumentArray` (contract ↔ serving-API translation).
- `runtime` - `getAiSearchRuntime` / `resetAiSearchRuntime` (the shared client).
- `schema` - the tool descriptions and re-exported request schemas.

Browser-safe schemas live in
[`@dbx-tools/shared-ai-search`](../../shared/ai-search); the React search box
lives in [`@dbx-tools/ui-ai-search`](../../ui/ai-search). Model resolution reuses
[`@dbx-tools/model`](../model).
