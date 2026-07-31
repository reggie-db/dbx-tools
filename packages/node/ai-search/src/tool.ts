/**
 * The `search`, `universal_search`, and (opt-in) `add_documents`,
 * `create_index`, and `sync_index` Mastra tools.
 *
 * All three read the shared runtime primed by the plugin, so a tool spread
 * into an agent uses the deployment's default index, columns, page size, and
 * mode without any per-tool wiring. They run under the caller's OBO scope (the
 * client resolves the execution context's workspace client), so search runs as
 * the requesting user and Unity Catalog ACLs apply.
 *
 * The same tools are exposed to AppKit's own agents through the plugin's
 * `ToolProvider` (see `plugin.ts`); this module is the Mastra half.
 *
 * @module
 */

import { search as searchContract, type UpsertResult } from "@dbx-tools/shared-ai-search";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { toCreateIndexOptions } from "./index-tools.ts";
import { toDocumentArray } from "./query.ts";
import { getAiSearchRuntime } from "./runtime.ts";
import {
  ADD_DOCUMENTS_TOOL_DESCRIPTION,
  CREATE_INDEX_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SYNC_INDEX_TOOL_DESCRIPTION,
  UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
  createIndexToolSchema,
  indexInfoSchema,
  searchResultSchema,
  searchToolSchema,
  syncIndexToolSchema,
  universalSearchToolSchema,
} from "./schema.ts";

/** Common option accepted by every tool factory: override the tool id. */
export interface SearchToolOptions {
  /** Override the tool id (defaults per tool). */
  id?: string;
}

/**
 * Build the `search` tool. Spread it into any agent that should be able to look
 * things up in an index.
 *
 * @example
 * ```ts
 * import { searchTool } from "@dbx-tools/ai-search";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "Answer from the docs. Use `search` to find them.",
 *   tools: () => ({ search: searchTool() }),
 * });
 * ```
 */
export function searchTool(options: SearchToolOptions = {}) {
  return createTool({
    id: options.id ?? "search",
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: searchToolSchema,
    outputSchema: searchResultSchema,
    execute: async (input, context) => {
      const request = searchToolSchema.parse(input);
      const { client } = getAiSearchRuntime();
      return client.search(request.query, {
        ...(request.index ? { index: request.index } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.columns ? { columns: request.columns } : {}),
        ...(request.filter ? { filter: request.filter } : {}),
        ...(request.scoreThreshold !== undefined ? { scoreThreshold: request.scoreThreshold } : {}),
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
      });
    },
  });
}

/** Build the `universal_search` tool (federated search across every index). */
export function universalSearchTool(options: SearchToolOptions = {}) {
  return createTool({
    id: options.id ?? "universal_search",
    description: UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
    inputSchema: universalSearchToolSchema,
    outputSchema: searchResultSchema,
    execute: async (input, context) => {
      const request = universalSearchToolSchema.parse(input);
      const { client } = getAiSearchRuntime();
      return client.universalSearch(request.query, {
        ...(request.indexes ? { indexes: request.indexes } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
      });
    },
  });
}

/**
 * Build the opt-in `add_documents` tool (write into a direct-access index).
 * Only install it when the plugin's write surface is enabled.
 */
export function addDocumentsTool(options: SearchToolOptions = {}) {
  const inputSchema = searchContract.searchDocumentSchema
    .array()
    .describe("Documents to add or update. Each must include the index primary key.");
  return createTool({
    id: options.id ?? "add_documents",
    description: ADD_DOCUMENTS_TOOL_DESCRIPTION,
    inputSchema: searchContract.searchRequestSchema
      .pick({ index: true })
      .extend({ documents: inputSchema }),
    outputSchema: searchContract.upsertResultSchema,
    execute: async (input, context): Promise<UpsertResult> => {
      const { client, config } = getAiSearchRuntime();
      const record = input as { index?: string; documents: unknown };
      const documents = toDocumentArray(record.documents);
      const index = record.index ?? config.defaultIndex ?? "";
      return client.addDocuments(index, documents, context?.abortSignal);
    },
  });
}

/**
 * Build the opt-in `create_index` tool (provision a Vector Search index).
 * Only install it when the plugin's write surface is enabled. Delegates to
 * {@link SearchClient.createIndex}, inferring the endpoint, embedding model,
 * key, and columns from the request + plugin config.
 */
export function createIndexTool(options: SearchToolOptions = {}) {
  return createTool({
    id: options.id ?? "create_index",
    description: CREATE_INDEX_TOOL_DESCRIPTION,
    inputSchema: createIndexToolSchema,
    outputSchema: indexInfoSchema,
    execute: async (input, context) => {
      const request = createIndexToolSchema.parse(input);
      const { client } = getAiSearchRuntime();
      return client.createIndex(request.name, toCreateIndexOptions(request, context?.abortSignal));
    },
  });
}

/** Output schema for the `sync_index` tool. */
const syncIndexResultSchema = z.object({
  index: z.string().describe("The index that was synced."),
  synced: z.boolean().describe("True once the sync was triggered."),
});

/**
 * Build the opt-in `sync_index` tool (refresh a Delta Sync index from its
 * source table). Only install it when the plugin's write surface is enabled.
 */
export function syncIndexTool(options: SearchToolOptions = {}) {
  return createTool({
    id: options.id ?? "sync_index",
    description: SYNC_INDEX_TOOL_DESCRIPTION,
    inputSchema: syncIndexToolSchema,
    outputSchema: syncIndexResultSchema,
    execute: async (input, context) => {
      const request = syncIndexToolSchema.parse(input);
      const { client, config } = getAiSearchRuntime();
      const index = request.index ?? config.defaultIndex ?? "";
      await client.syncIndex(index, context?.abortSignal);
      return { index, synced: true };
    },
  });
}
