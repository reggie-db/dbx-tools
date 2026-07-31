/**
 * Tool-facing descriptions and the request schemas the Mastra tools + AppKit
 * tool provider validate against. The wire shapes themselves live in
 * `@dbx-tools/shared-search`; this module adds the model-readable
 * descriptions so both hosts describe the tools identically.
 *
 * @module
 */

import { search } from "@dbx-tools/shared-search";
import { string } from "@dbx-tools/shared-core";

/** Description the model reads for the `search` tool. */
export const SEARCH_TOOL_DESCRIPTION = string.toDescription(`
  Search a Databricks AI Search (Vector Search) index for the documents most
  relevant to a query. Pass a natural-language question or keywords; hybrid
  matching combines semantic similarity with keyword ranking, so exact terms
  (product names, error codes) and paraphrases both work. Optionally name an
  index (defaults to the app's configured index), a result limit, and attribute
  filters. Use it to look up docs, knowledge-base articles, products, or any
  indexed content before answering.
`);

/** Description the model reads for the `universal_search` tool. */
export const UNIVERSAL_SEARCH_TOOL_DESCRIPTION = string.toDescription(`
  Search across every configured AI Search index at once and return the best
  matches from all of them, merged and ranked. Use it when the right index
  isn't known in advance or when an answer may live in any of several
  collections (docs, tickets, products).
`);

/** Description the model reads for the `add_documents` tool. */
export const ADD_DOCUMENTS_TOOL_DESCRIPTION = string.toDescription(`
  Add or update documents in a direct-access AI Search index. Pass an array of
  documents as JSON objects; each MUST include the index's primary-key column.
  Only available when the app enables the write surface. Use it to index new
  content the user provides.
`);

/** Description the model reads for the `create_index` tool. */
export const CREATE_INDEX_TOOL_DESCRIPTION = string.toDescription(`
  Create a Databricks AI Search (Vector Search) index. For the common case pass
  a Delta source table (catalog.schema.table): Databricks computes embeddings
  from its text column and keeps the index synced. To create a direct-access
  index you write vectors to yourself, pass an embedding dimension instead of a
  source table. The endpoint, embedding model, primary key, and text column are
  inferred when omitted. Only available when the app enables the write surface.
  Creating an index provisions infrastructure - do this only when the user
  explicitly asks to set up a new index.
`);

/** Description the model reads for the `sync_index` tool. */
export const SYNC_INDEX_TOOL_DESCRIPTION = string.toDescription(`
  Refresh a Delta Sync AI Search index from its source table so newly added or
  changed rows become searchable. Optionally name the index (defaults to the
  app's default index). Only available when the app enables the write surface.
`);

/** Schema for the `search` tool input (the shared request schema). */
export const searchToolSchema = search.searchRequestSchema;

/** Schema for the `universal_search` tool input. */
export const universalSearchToolSchema = search.universalSearchRequestSchema;

/** Schema for the `search` / `universal_search` tool output. */
export const searchResultSchema = search.searchResultSchema;

/** Schema for the `create_index` tool input. */
export const createIndexToolSchema = search.createIndexRequestSchema;

/** Schema for the `create_index` tool output (a resolved index definition). */
export const indexInfoSchema = search.indexInfoSchema;

/** Schema for the `sync_index` tool input. */
export const syncIndexToolSchema = search.syncIndexRequestSchema;
