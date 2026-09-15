/**
 * Shared request-to-client option mapping for Search adapters.
 *
 * @module
 */

import type { SearchRequest, UniversalSearchRequest } from "@dbx-tools/shared-search";
import type { SearchOptions, UniversalSearchOptions } from "./client.ts";

/** Translate a validated single-index request into client options. */
export function toSearchOptions(
  request: SearchRequest,
  signal?: AbortSignal,
): SearchOptions & { index?: string } {
  return {
    ...(request.index ? { index: request.index } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.columns ? { columns: request.columns } : {}),
    ...(request.filter ? { filter: request.filter } : {}),
    ...(request.scoreThreshold !== undefined ? { scoreThreshold: request.scoreThreshold } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** Translate a validated federated request into client options. */
export function toUniversalSearchOptions(
  request: UniversalSearchRequest,
  signal?: AbortSignal,
): UniversalSearchOptions {
  return {
    ...(request.indexes ? { indexes: request.indexes } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
    ...(request.mode ? { mode: request.mode } : {}),
    ...(signal ? { signal } : {}),
  };
}
