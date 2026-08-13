/**
 * Adapter from AppKit's native AI Search provider to the dbx-tools extension
 * contract used by federated search and agent tools.
 *
 * @module
 */

import { ValidationError } from "@databricks/appkit";
import type {
  SearchFilters as AppKitSearchFilters,
  SearchRequest as AppKitSearchRequest,
  SearchResponse as AppKitSearchResponse,
} from "@databricks/appkit/beta";
import {
  search as sharedSearch,
  type SearchDocument,
  type SearchHit,
  type SearchRequest as ExtensionSearchRequest,
  type SearchResult,
  type UpsertResult,
} from "@dbx-tools/shared-search";
import { string } from "@dbx-tools/shared-core";
import type { SearchOptions, SearchReadBackend } from "./client.ts";
import { indexConfigFor, type ResolvedSearchConfig } from "./config.ts";

/** Minimal query surface exposed by AppKit's native `aiSearch` plugin. */
export interface AiSearchProvider {
  providerKind?: "lakebase";
  query(alias: string, request: AppKitSearchRequest): Promise<AppKitSearchResponse>;
  addDocuments?(alias: string, documents: SearchDocument[]): Promise<UpsertResult>;
}

function filters(value: ExtensionSearchRequest["filter"]): AppKitSearchFilters | undefined {
  if (!value) return undefined;
  const result: AppKitSearchFilters = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      (Array.isArray(item) &&
        item.every((entry) => typeof entry === "string" || typeof entry === "number"))
    ) {
      result[key] = item;
      continue;
    }
    throw new ValidationError(
      `AI Search filter "${key}" must be a string, number, boolean, or string/number array`,
    );
  }
  return result;
}

function hitId(
  data: Record<string, unknown>,
  primaryKey: string | undefined,
  index: number,
): string {
  const value = data[primaryKey ?? "id"] ?? Object.values(data)[0] ?? index;
  return String(value);
}

function aliasFor(index: string, config: ResolvedSearchConfig): string {
  const alias = indexConfigFor(config, index)?.alias ?? string.trimToNull(index);
  if (!alias) throw new ValidationError("AI Search requires a configured index alias");
  return alias;
}

/** Build a read backend that delegates every Vector Search query to AppKit. */
export function nativeAiSearchBackend(
  provider: AiSearchProvider,
  config: ResolvedSearchConfig,
): SearchReadBackend {
  const backend: SearchReadBackend = {
    supportsLifecycle: provider.providerKind !== "lakebase",
    async search(index: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
      options.signal?.throwIfAborted();
      const known = indexConfigFor(config, index);
      const alias = aliasFor(index, config);
      const resolvedQueryType = sharedSearch.toAiSearchQueryType(options.mode);
      const resolvedFilters = filters(options.filter);
      const response = await provider.query(alias, {
        queryText: query,
        numResults: options.limit ?? config.pageSize,
        ...(options.columns ? { columns: [...options.columns] } : {}),
        ...(resolvedQueryType ? { queryType: resolvedQueryType } : {}),
        ...(resolvedFilters ? { filters: resolvedFilters } : {}),
      });
      options.signal?.throwIfAborted();
      const hits: SearchHit[] = response.results
        .map((result, resultIndex) => ({
          id: hitId(result.data, known?.primaryKey, resultIndex),
          score: result.score,
          fields: result.data,
        }))
        .filter(
          (hit) => options.scoreThreshold === undefined || hit.score >= options.scoreThreshold,
        );
      return { query, index, hits, count: hits.length };
    },
  };
  const addDocuments = provider.addDocuments?.bind(provider);
  if (!addDocuments) return backend;
  return {
    ...backend,
    async addDocuments(
      index: string,
      documents: SearchDocument[],
      signal?: AbortSignal,
    ): Promise<UpsertResult> {
      signal?.throwIfAborted();
      const result = await addDocuments(aliasFor(index, config), documents);
      signal?.throwIfAborted();
      return result;
    },
  };
}
