/**
 * Live Databricks Model Serving catalogue access.
 *
 * Lists the workspace's `/serving-endpoints` and, when the caller supplies a
 * trusted credential identity, caches the result per host and identity with a
 * TTL via `@dbx-tools/cache`. Concurrent callers in the same scope share
 * one in-flight promise. Surfaces each endpoint as a stable
 * {@link ServingEndpointSummary} - including the Foundation Model API
 * `quality` / `speed` / `cost` profile when present, the classified
 * {@link ModelClass}, and (for embedding endpoints) the measured vector
 * `dimension` - and snaps loose, human-typed names to real endpoint ids
 * through the TypeScript model ranker so tokens like `"claude sonnet"` resolve to
 * `databricks-claude-sonnet-4-6`.
 *
 * The class stamp and embedding dimension are computed once per cache load:
 * every embedding endpoint is "pinged" in parallel and the resulting vector
 * length recorded, so the cost is paid on a cache miss, not per read. The ping
 * is best-effort - a failure logs at debug and leaves `dimension` unset rather
 * than failing the whole listing.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { appkit } from "@dbx-tools/appkit";
import { deleteCachedValue, getOrSet } from "@dbx-tools/cache";
import { log, toError } from "@dbx-tools/shared-core";
import {
  type ResolvedModel,
  type ResolveModelOptions,
  type ScoredEndpoint,
  type ServingEndpointSummary,
  ModelClass,
} from "@dbx-tools/shared-model";

import { modelCatalogueCache } from "./_cache.ts";
import { classifyEndpointClasses, normalizeEndpoints, rankEndpoints } from "./_ranking.ts";

const logger = log.logger("model/serving");

/**
 * Structural type for the Databricks workspace client, re-exported so the rest
 * of this package can keep importing it from here. See
 * `appkit.WorkspaceClientLike` (node-appkit) for the canonical definition.
 */
export type WorkspaceClientLike = Pick<appkit.WorkspaceClientLike, "servingEndpoints">;

/** Default TTL for the in-memory endpoint cache. Matches the Databricks SDK's session lifetime budget. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Default fuzzy distance threshold below which a match is accepted. */
export const DEFAULT_FUZZY_THRESHOLD = 0.4;

/** Cache key parts under which endpoint listings are stored. */
const CACHE_KEY_NAMESPACE = "serving-endpoints";
const catalogueCache = modelCatalogueCache;

/** Options for {@link listServingEndpoints}. */
export interface ListServingEndpointsOptions {
  /**
   * Override the default cache TTL for this call, in milliseconds.
   */
  ttlMs?: number;
  /**
   * Trusted identity of the credential used by `client`.
   *
   * The value is hashed before it enters the cache key and is never logged.
   * Omit it when the caller cannot prove the credential identity; that call
   * bypasses shared caching so one principal can never read another's
   * catalogue.
   */
  cacheIdentity?: string;
  /** Measure embedding vector dimensions during this catalogue load. Defaults to true. */
  measureEmbeddingDimensions?: boolean;
}

/** Hash an opaque credential identity before handing it to the shared cache. */
function cacheUserKey(identity: string): string {
  return `model-${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * List Model Serving endpoints for the workspace owning `client`, routed
 * through the shared memory-first cache, including per-entry TTL, in-flight
 * request coalescing, bounded process memory, and portable persistence.
 *
 * Returns plain {@link ServingEndpointSummary} objects (a stable subset of the
 * SDK type) so cache hits never expose stale SDK internals.
 *
 * @param host - Workspace host used as the cache key. Pass the value resolved
 *   from `client.config.getHost()` so multi-host apps share one entry per
 *   workspace.
 * @param options.ttlMs - Override the default TTL just for this call.
 */
export async function listServingEndpoints(
  client: WorkspaceClientLike,
  host: string,
  options: ListServingEndpointsOptions = {},
): Promise<ServingEndpointSummary[]> {
  const measureDimensions = options.measureEmbeddingDimensions !== false;
  if (!options.cacheIdentity) return fetchEndpoints(client, measureDimensions);
  return (await getOrSet(
    catalogueCache,
    catalogueCacheKey(host, options.cacheIdentity, measureDimensions),
    () => fetchEndpoints(client, measureDimensions),
    {
      ttl: options.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
      returnCachedOnError: true,
      cachedOnErrorTtl: "7d",
      throwErrors: true,
    },
  ))!;
}

/**
 * List the workspace's serving endpoints as minimal
 * {@link ServingEndpointSummary} objects straight from the SDK: no caching, and
 * none of the cache-load enrichment ({@link listServingEndpoints} adds the
 * {@link ModelClass} stamp and the embedding-dimension probe). Use this for a
 * one-shot, dependency-light listing - e.g. a CLI that only needs names/tasks
 * for fuzzy resolution and doesn't want shared cache persistence or the
 * per-embedding ping cost. Prefer {@link listServingEndpoints} for the cached,
 * enriched view.
 */
export async function listServingEndpointsUncached(
  client: WorkspaceClientLike,
): Promise<ServingEndpointSummary[]> {
  const endpoints: unknown[] = [];
  for await (const ep of client.servingEndpoints.list()) {
    endpoints.push(ep);
  }
  return normalizeEndpoints(endpoints);
}

async function fetchEndpoints(
  client: WorkspaceClientLike,
  measureDimensions: boolean,
): Promise<ServingEndpointSummary[]> {
  const startedAt = Date.now();
  const classified = stampModelClasses(await listServingEndpointsUncached(client));
  const out = measureDimensions ? await measureEmbeddingDimensions(client, classified) : classified;
  logger.debug("listed", { count: out.length, elapsedMs: Date.now() - startedAt });
  return out;
}

/**
 * Stamp each summary's {@link ServingEndpointSummary.class} from the relative
 * classification of the whole set. Endpoints the classifier doesn't recognize
 * (custom, unscored, non-LLM) are left without a class.
 */
function stampModelClasses(summaries: readonly ServingEndpointSummary[]): ServingEndpointSummary[] {
  const classOf = classifyEndpointClasses(summaries);
  return summaries.map((summary) => {
    const cls = classOf.get(summary.name);
    return cls === undefined ? summary : { ...summary, class: cls };
  });
}

/**
 * Measure the embedding vector dimension of every {@link ModelClass.Embedding}
 * endpoint by pinging it once, all in parallel. Runs only on a cache miss (it's
 * called from {@link fetchEndpoints}), so the probe cost is amortized across the
 * cached TTL window. Per-endpoint failures are swallowed (logged at warn) so one
 * unreachable embedding model never fails the listing.
 */
async function measureEmbeddingDimensions(
  client: WorkspaceClientLike,
  summaries: readonly ServingEndpointSummary[],
): Promise<ServingEndpointSummary[]> {
  return Promise.all(
    summaries.map(async (summary) => {
      if (summary.class !== ModelClass.Embedding) return summary;
      const dimension = await pingEmbeddingDimension(client, summary.name);
      return dimension === undefined ? summary : { ...summary, dimension };
    }),
  );
}

/**
 * Best-effort embedding dimension probe: query `name` with a tiny `"ping"`
 * input and return the length of the returned vector. Returns `undefined` (and
 * logs at warn) when the endpoint can't be queried or returns no vector - the
 * dimension is informational, never required.
 */
async function pingEmbeddingDimension(
  client: WorkspaceClientLike,
  name: string,
): Promise<number | undefined> {
  try {
    const response = await client.servingEndpoints.query({ name, input: "ping" });
    const dimension = response.data?.[0]?.embedding?.length;
    if (typeof dimension === "number" && dimension > 0) return dimension;
    logger.warn("embedding ping returned no vector", { name });
    return undefined;
  } catch (err) {
    logger.warn("embedding ping failed", { name, error: toError(err) });
    return undefined;
  }
}

/**
 * Force-evict cached endpoint listings. A host and identity delete only that
 * principal's workspace entry. Omitting either value clears this catalogue.
 */
export async function clearServingEndpointsCache(
  host?: string,
  cacheIdentity?: string,
): Promise<void> {
  if (host && cacheIdentity) {
    await Promise.all([
      deleteCachedValue(catalogueCache, catalogueCacheKey(host, cacheIdentity, true)),
      deleteCachedValue(catalogueCache, catalogueCacheKey(host, cacheIdentity, false)),
    ]);
  } else {
    await catalogueCache.clear();
  }
}

function catalogueCacheKey(
  host: string,
  cacheIdentity: string,
  measureDimensions: boolean,
): string {
  return JSON.stringify([
    CACHE_KEY_NAMESPACE,
    host,
    cacheUserKey(cacheIdentity),
    measureDimensions ? "dimensions" : "chat-only",
  ]);
}

/**
 * Result of fuzzy-resolving a user-supplied model name against the live
 * endpoint list. `score` is the ranker's distance (`0` is exact, `1` is no match);
 * `matched` is `false` when the score exceeds the configured threshold so
 * callers can fall back to the original input (Databricks will then return a
 * clean 404).
 */
/**
 * Fuzzy-rank endpoints by how closely their `name` matches `input`, best
 * (lowest score) first, keeping only those within `threshold`:
 *
 * 1. An exact name match short-circuits to a single `score: 0` result.
 * 2. Otherwise the shared TypeScript policy tokenizes and scores every endpoint through the
 *    same fuzzy-distance policy used by {@link lookupModels}.
 *
 * Returns `[]` for an empty endpoint list or when `input` tokenizes to nothing,
 * so callers fall back to the raw input and let Databricks surface a clean 404.
 * This multi-result core is shared by {@link resolveModelId} (single best) and
 * the ranked `lookupModels` selector.
 */
export function searchServingEndpoints(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  options: ResolveModelOptions = {},
): ScoredEndpoint[] {
  if (endpoints.length === 0 || !input.trim()) return [];
  return rankEndpoints(
    endpoints,
    {
      search: input,
      ...(options.requiresTools !== undefined ? { requiresTools: options.requiresTools } : {}),
      ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
      threshold: options.threshold ?? DEFAULT_FUZZY_THRESHOLD,
    },
    {
      includeDeprecated: true,
      task: "llm/v1/chat",
    },
  ).map((ranked) => ({ endpoint: ranked.endpoint, score: ranked.score ?? 0 }));
}

/**
 * Snap a user-supplied model name to the single closest configured serving
 * endpoint via {@link searchServingEndpoints}. Returns the input unchanged with
 * `matched: false` when nothing scores within the threshold (or the catalogue
 * is empty), so a deliberate model id is never silently rewritten to a
 * similar-looking neighbour and the upstream call surfaces the canonical 404.
 */
export function resolveModelId(
  input: string,
  endpoints: readonly ServingEndpointSummary[],
  options: ResolveModelOptions = {},
): ResolvedModel {
  const [best] = searchServingEndpoints(input, endpoints, options);
  if (best) {
    return { modelId: best.endpoint.name, matched: true, score: best.score };
  }
  return { modelId: input, matched: false };
}
