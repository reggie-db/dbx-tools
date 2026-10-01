/**
 * Shared translation from the browser-safe {@link CreateIndexRequest} wire
 * shape onto the client's {@link CreateIndexOptions}. Lives in its own module
 * because both the Mastra `create_index` tool (`tool.ts`) and the AppKit tool
 * provider (`plugin.ts`) build the same options object, and the mapping (which
 * optional fields to spread, folding in the abort signal) is easy to let drift
 * between the two.
 *
 * @module
 */

import type { CreateIndexRequest } from "@dbx-tools/shared-search";
import type { CreateIndexOptions } from "./client.ts";

/**
 * Map a validated {@link CreateIndexRequest} onto {@link CreateIndexOptions},
 * spreading only the fields that were supplied so the client's own defaults
 * (endpoint, embedding model, primary key, text column) still apply, and
 * folding in the caller's abort signal.
 */
export function toCreateIndexOptions(
  request: CreateIndexRequest,
  signal?: AbortSignal,
): CreateIndexOptions {
  return {
    ...(request.sourceTable ? { sourceTable: request.sourceTable } : {}),
    ...(request.primaryKey ? { primaryKey: request.primaryKey } : {}),
    ...(request.embeddingSourceColumn
      ? { embeddingSourceColumn: request.embeddingSourceColumn }
      : {}),
    ...(request.embeddingModel ? { embeddingModel: request.embeddingModel } : {}),
    ...(request.endpoint ? { endpoint: request.endpoint } : {}),
    ...(request.embeddingDimension !== undefined
      ? { embeddingDimension: request.embeddingDimension }
      : {}),
    ...(request.pipelineType ? { pipelineType: request.pipelineType } : {}),
    ...(request.columnsToSync ? { columnsToSync: request.columnsToSync } : {}),
    ...(signal ? { signal } : {}),
  };
}
