/**
 * Wire-format contract for the AI Search add-on: the query a caller (a UI
 * search box, a Mastra tool, a universal-search route) sends and the hits it
 * gets back, plus the document shape used to add / update index contents.
 *
 * Pure (zod + inferred types, no Node-only imports) so the server-side client
 * in `@dbx-tools/search`, the Mastra tool, the `POST /api/search` route,
 * and the React search box all validate / type against ONE definition.
 *
 * "AI Search" is Databricks' current name for Vector Search: an index built
 * from a Delta table (or written directly) that answers a natural-language
 * query with the most relevant rows, combining vector similarity with BM25
 * keyword matching (hybrid). This contract is index-agnostic - it names the
 * index by its Unity Catalog path and returns hits as `{ id, score, fields }`
 * so the same shape serves an autocomplete box, a docs lookup, and a
 * federated search across many indexes.
 *
 * Array fields intentionally avoid `.min()` / `.nonempty()`: those emit
 * `minItems` in the JSON schema, which some Model Serving endpoints reject
 * when the schema is forwarded as a tool definition.
 *
 * @module
 */

import { z } from "zod";

/**
 * How a query is matched. `hybrid` (the default) fuses vector similarity with
 * BM25 keyword ranking - the right choice for most search boxes and for source
 * data with exact identifiers (SKUs, error codes). `vector` is pure semantic
 * similarity; `keyword` is pure BM25 full-text (Beta on Databricks). The
 * value maps onto the serving API's `query_type` (`ANN` / `HYBRID`).
 */
export const searchModeSchema = z
  .enum(["hybrid", "vector", "keyword"])
  .describe(
    "Match strategy: 'hybrid' fuses semantic similarity with keyword ranking (default, best for most searches), 'vector' is pure semantic, 'keyword' is pure full-text.",
  );

/** How a query is matched (see {@link searchModeSchema}). */
export type SearchMode = z.infer<typeof searchModeSchema>;

/** Schema for a search request against a single index. */
export const searchRequestSchema = z.object({
  query: z
    .string()
    .describe(
      "What to search for, as natural language or keywords. Prefix fragments work for autocomplete.",
    ),
  index: z
    .string()
    .optional()
    .describe(
      "Unity Catalog name of the index to search (catalog.schema.index). Defaults to the plugin's configured index. Accepts a short alias when one is configured.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of hits to return. Defaults to the plugin's configured page size."),
  mode: searchModeSchema.optional(),
  columns: z
    .array(z.string())
    .optional()
    .describe(
      "Which document columns to return per hit. Defaults to the plugin's configured columns (or all indexed columns).",
    ),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Attribute filters as { column: value } (a value, or an operator map like { ">=": 10 }). Combined with AND. Maps onto the index `filters_json`.',
    ),
  scoreThreshold: z
    .number()
    .optional()
    .describe("Drop hits whose relevance score is below this value."),
});

/** A validated search request ({@link searchRequestSchema}). */
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** Schema for a single search hit. */
export const searchHitSchema = z.object({
  id: z.string().describe("The document's primary-key value."),
  score: z.number().describe("Relevance score; higher is more relevant."),
  fields: z
    .record(z.string(), z.unknown())
    .describe("The returned columns for this document, keyed by column name."),
  index: z
    .string()
    .optional()
    .describe("Which index the hit came from (set on universal/federated results)."),
});

/** A single search hit ({@link searchHitSchema}). */
export type SearchHit = z.infer<typeof searchHitSchema>;

/** Schema for the result of a search. */
export const searchResultSchema = z.object({
  query: z.string().describe("Echo of the query that was searched."),
  hits: z.array(searchHitSchema).describe("Matching documents, most relevant first."),
  index: z.string().optional().describe("The index searched (omitted for a universal search)."),
  count: z.number().int().describe("Number of hits returned."),
});

/** The outcome of a search ({@link searchResultSchema}). */
export type SearchResult = z.infer<typeof searchResultSchema>;

/** Schema for a universal (federated) search across several indexes at once. */
export const universalSearchRequestSchema = z.object({
  query: z.string().describe("What to search for across every configured index."),
  indexes: z
    .array(z.string())
    .optional()
    .describe("Which indexes to search. Defaults to every index the plugin knows about."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum hits PER index before results are merged and re-ranked."),
  mode: searchModeSchema.optional(),
});

/** A validated universal-search request ({@link universalSearchRequestSchema}). */
export type UniversalSearchRequest = z.infer<typeof universalSearchRequestSchema>;

/** Schema for a document written to a direct-access index. */
export const searchDocumentSchema = z
  .record(z.string(), z.unknown())
  .describe("A document as { column: value }. Must include the index primary-key column.");

/** A document written to an index ({@link searchDocumentSchema}). */
export type SearchDocument = z.infer<typeof searchDocumentSchema>;

/** Schema for the result of adding / updating documents. */
export const upsertResultSchema = z.object({
  index: z.string().describe("The index the documents were written to."),
  count: z.number().int().describe("Number of documents accepted."),
});

/** The outcome of an add-documents call ({@link upsertResultSchema}). */
export type UpsertResult = z.infer<typeof upsertResultSchema>;

/**
 * Schema for the boot-time index catalogue a UI reads to populate a search box
 * (the payload of the plugin's client config / `GET /api/search/indexes`). An
 * entry names an index, an optional short alias, and the columns worth
 * showing, so a search box needs no server round-trip to render.
 */
export const searchIndexInfoSchema = z.object({
  name: z.string().describe("Unity Catalog name of the index (catalog.schema.index)."),
  alias: z.string().optional().describe("Short alias the plugin accepts in place of `name`."),
  primaryKey: z.string().optional().describe("The index's primary-key column, when known."),
  columns: z
    .array(z.string())
    .optional()
    .describe("Columns returned by default, in display order."),
  isDefault: z.boolean().optional().describe("True for the plugin's default index."),
});

/** One entry in the index catalogue ({@link searchIndexInfoSchema}). */
export type SearchIndexInfo = z.infer<typeof searchIndexInfoSchema>;

/** Schema for the plugin's client config surfaced to a UI. */
export const searchClientConfigSchema = z.object({
  indexes: z.array(searchIndexInfoSchema).describe("Indexes the search UI may query."),
  defaultIndex: z.string().optional().describe("The index a search box selects by default."),
  pageSize: z.number().int().describe("Default number of hits a search returns."),
  basePath: z
    .string()
    .describe("Base path the search routes are mounted under (e.g. /api/search)."),
});

/** The plugin's client config ({@link searchClientConfigSchema}). */
export type SearchClientConfig = z.infer<typeof searchClientConfigSchema>;

/**
 * Schema for creating an index (the `create_index` tool input / the
 * `POST /api/search/index` body). Two shapes, both inferring aggressively:
 * pass `sourceTable` for a Delta Sync index (Databricks computes embeddings and
 * keeps it synced) or `embeddingDimension` for a direct-access index you write
 * vectors to yourself.
 */
export const createIndexRequestSchema = z.object({
  name: z.string().describe("Unity Catalog name for the new index (catalog.schema.index)."),
  sourceTable: z
    .string()
    .optional()
    .describe(
      "Delta table (catalog.schema.table) to build a synced index from. Provide this OR embeddingDimension.",
    ),
  primaryKey: z.string().optional().describe("Primary-key column. Defaults to 'id'."),
  embeddingSourceColumn: z
    .string()
    .optional()
    .describe(
      "Text column embeddings are computed from (Delta Sync). Defaults to the first of text/content/body.",
    ),
  embeddingModel: z
    .string()
    .optional()
    .describe(
      "Embedding model endpoint (name or loose name). Defaults to the app's embedding model, or the best embedding endpoint in the workspace.",
    ),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Vector Search endpoint to host the index on. Defaults to the app's configured endpoint.",
    ),
  embeddingDimension: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For a direct-access index (no source table): the embedding vector dimension."),
  pipelineType: z
    .enum(["TRIGGERED", "CONTINUOUS"])
    .optional()
    .describe(
      "Delta Sync mode: 'TRIGGERED' (default) syncs on demand; 'CONTINUOUS' keeps the index fresh.",
    ),
  columnsToSync: z
    .array(z.string())
    .optional()
    .describe("Extra columns to sync alongside the embedding source column (Delta Sync)."),
});

/** A validated create-index request ({@link createIndexRequestSchema}). */
export type CreateIndexRequest = z.infer<typeof createIndexRequestSchema>;

/** Schema for the `sync_index` tool input / the `POST /api/search/index/sync` body. */
export const syncIndexRequestSchema = z.object({
  index: z
    .string()
    .describe(
      "The index to sync (name or configured alias). Defaults to the app's default index when omitted.",
    )
    .optional(),
});

/** A validated sync-index request ({@link syncIndexRequestSchema}). */
export type SyncIndexRequest = z.infer<typeof syncIndexRequestSchema>;

/** Schema for a resolved index definition (the create/get result). */
export const indexInfoSchema = z.object({
  name: z.string().describe("Unity Catalog name of the index."),
  endpoint: z.string().optional().describe("The Vector Search endpoint hosting the index."),
  primaryKey: z.string().optional().describe("The index's primary-key column."),
  columns: z.array(z.string()).describe("Columns available on the index."),
  ready: z.boolean().describe("True when the index has finished provisioning and can be queried."),
  rowCount: z.number().int().optional().describe("Number of indexed rows, when known."),
});

/** A resolved index definition ({@link indexInfoSchema}). */
export type IndexInfo = z.infer<typeof indexInfoSchema>;
