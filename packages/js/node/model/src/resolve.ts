/**
 * Workspace-aware model selection wrappers.
 *
 * @module
 */
import type { ModelQuery, RankedModel, ServingEndpointSummary } from "@dbx-tools/shared-model";

import {
  lookupModels,
  rankModelId,
  type ResolveModelInput,
  type ResolvedModelSelection,
  resolveModel,
} from "./_selection.ts";
import {
  listServingEndpoints,
  type ListServingEndpointsOptions,
  type ResolvedModel,
  type ResolveModelOptions,
  type WorkspaceClientLike,
} from "./model-catalog.ts";

export { lookupModels, rankModelId, resolveModel } from "./_selection.ts";
export type { ResolveModelInput, ResolvedModelSelection } from "./_selection.ts";

/** Intent plus catalogue cache controls passed to {@link selectModel}. */
export interface SelectModelInput extends ResolveModelInput {
  ttlMs?: number;
  cacheIdentity?: string;
}

/** Query plus catalogue cache controls passed to {@link searchModels}. */
export interface SearchModelsInput extends ModelQuery {
  ttlMs?: number;
  cacheIdentity?: string;
}

/** Resolve against a potentially stale catalogue, refreshing once on a miss. */
export async function rankModelIdLive(
  load: (force: boolean) => Promise<readonly ServingEndpointSummary[]>,
  search: string,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  const resolved = rankModelId(await load(false), search, options);
  if (resolved.matched) return resolved;
  return rankModelId(await load(true), search, options);
}

/** List and rank a workspace model catalogue. */
export async function searchModels(
  client: WorkspaceClientLike,
  host: string,
  input: SearchModelsInput = {},
): Promise<RankedModel[]> {
  const endpoints = await listServingEndpoints(client, host, catalogueOptions(input));
  return lookupModels(endpoints, input);
}

/** List a workspace catalogue and resolve one model. */
export async function selectModel(
  client: WorkspaceClientLike,
  host: string,
  input: SelectModelInput = {},
): Promise<ResolvedModelSelection> {
  if (input.explicit !== undefined && input.fuzzy === false && !input.requiresTools) {
    return { modelId: input.explicit, source: "explicit" };
  }
  const endpoints = await listServingEndpoints(client, host, catalogueOptions(input));
  return resolveModel(endpoints, input);
}

function catalogueOptions(input: {
  readonly ttlMs?: number;
  readonly cacheIdentity?: string;
}): ListServingEndpointsOptions {
  return {
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.cacheIdentity !== undefined ? { cacheIdentity: input.cacheIdentity } : {}),
  };
}
