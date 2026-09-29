/**
 * The `search`, `universal_search`, and (opt-in) `add_documents`,
 * `create_index`, and `sync_index` Mastra tools.
 *
 * App-integrated agents should consume the plugin's native toolkit so calls
 * retain that plugin's config and provider backend. These standalone factories
 * capture an explicit runtime or build an isolated one from config plus a
 * provider. They run under the caller's OBO scope (the client resolves the
 * execution context's workspace client), so search runs as the requesting user
 * and Unity Catalog ACLs apply.
 *
 * The same tools are exposed to AppKit's own agents through the plugin's
 * `ToolProvider` (see `plugin.ts`).
 *
 * @module
 */

import { search as sharedSearch, type UpsertResult } from "@dbx-tools/shared-search";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { toSearchOptions, toUniversalSearchOptions } from "./_search-options.ts";
import type { SearchReadBackend } from "./client.ts";
import type { SearchPluginConfig } from "./config.ts";
import { toCreateIndexOptions } from "./index-tools.ts";
import { toDocumentArray } from "./query.ts";
import { createSearchRuntime, type SearchRuntime } from "./runtime.ts";
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

/** Options accepted by every standalone tool factory. */
export interface SearchToolOptions {
  /** Override the tool id (defaults per tool). */
  id?: string;
  /** Isolated runtime used by this standalone tool. Mutually exclusive with config/backend. */
  runtime?: SearchRuntime;
  /** Config used to create an isolated runtime. */
  config?: SearchPluginConfig;
  /** Provider used when creating a runtime from config. */
  readBackend?: SearchReadBackend;
}

/** Resolve the isolated runtime captured by one standalone tool factory. */
function toolRuntime(options: SearchToolOptions): SearchRuntime {
  if (options.runtime && (options.config || options.readBackend)) {
    throw new TypeError("search tool options accept runtime or config/readBackend, not both");
  }
  return (
    options.runtime ??
    createSearchRuntime({
      config: options.config,
      readBackend: options.readBackend,
    })
  );
}

/**
 * Build the `search` tool. Spread it into any agent that should be able to look
 * things up in an index.
 *
 * @example
 * ```ts
 * import { searchTool } from "@dbx-tools/search";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "Answer from the docs. Use `search` to find them.",
 *   tools: () => ({ search: searchTool() }),
 * });
 * ```
 */
export function searchTool(options: SearchToolOptions = {}) {
  const runtime = toolRuntime(options);
  return createTool({
    id: options.id ?? "search",
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: searchToolSchema,
    outputSchema: searchResultSchema,
    execute: async (input, context) => {
      const request = searchToolSchema.parse(input);
      return runtime.client.search(request.query, toSearchOptions(request, context?.abortSignal));
    },
  });
}

/** Build the `universal_search` tool (federated search across every index). */
export function universalSearchTool(options: SearchToolOptions = {}) {
  const runtime = toolRuntime(options);
  return createTool({
    id: options.id ?? "universal_search",
    description: UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
    inputSchema: universalSearchToolSchema,
    outputSchema: searchResultSchema,
    execute: async (input, context) => {
      const request = universalSearchToolSchema.parse(input);
      return runtime.client.universalSearch(
        request.query,
        toUniversalSearchOptions(request, context?.abortSignal),
      );
    },
  });
}

/**
 * Build the opt-in `add_documents` tool (write into a direct-access index).
 * Only install it when the plugin's write surface is enabled.
 */
export function addDocumentsTool(options: SearchToolOptions = {}) {
  const runtime = toolRuntime(options);
  const inputSchema = sharedSearch.searchDocumentSchema
    .array()
    .describe("Documents to add or update. Each must include the index primary key.");
  return createTool({
    id: options.id ?? "add_documents",
    description: ADD_DOCUMENTS_TOOL_DESCRIPTION,
    inputSchema: sharedSearch.searchRequestSchema
      .pick({ index: true })
      .extend({ documents: inputSchema }),
    outputSchema: sharedSearch.upsertResultSchema,
    execute: async (input, context): Promise<UpsertResult> => {
      const { client, config } = runtime;
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
  const runtime = toolRuntime(options);
  return createTool({
    id: options.id ?? "create_index",
    description: CREATE_INDEX_TOOL_DESCRIPTION,
    inputSchema: createIndexToolSchema,
    outputSchema: indexInfoSchema,
    execute: async (input, context) => {
      const request = createIndexToolSchema.parse(input);
      return runtime.client.createIndex(
        request.name,
        toCreateIndexOptions(request, context?.abortSignal),
      );
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
  const runtime = toolRuntime(options);
  return createTool({
    id: options.id ?? "sync_index",
    description: SYNC_INDEX_TOOL_DESCRIPTION,
    inputSchema: syncIndexToolSchema,
    outputSchema: syncIndexResultSchema,
    execute: async (input, context) => {
      const request = syncIndexToolSchema.parse(input);
      const { client, config } = runtime;
      const index = request.index ?? config.defaultIndex ?? "";
      await client.syncIndex(index, context?.abortSignal);
      return { index, synced: true };
    },
  });
}
