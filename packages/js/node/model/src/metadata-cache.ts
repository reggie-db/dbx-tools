/**
 * Daily model metadata cache built on the shared memory-first cache package.
 *
 * @module
 */

import { createCache, getOrSet } from "@dbx-tools/cache/cache";
import * as log from "@dbx-tools/shared-core/log";

import { modelMetadataCache } from "./_cache.ts";
import { MODEL_METADATA_TTL_MS } from "./_metadata-contract.ts";

const logger = log.logger("model/metadata-cache");

/** Factory inputs for one named metadata cache. */
export interface MetadataCacheOptions<T> {
  /** Stable cache key. */
  readonly key: string;
  /** Hard-coded / committed baseline used when store and load both miss. */
  readonly fallback: T;
  /** Optional refresh source. */
  readonly load?: () => Promise<T>;
  /** Combine a fresh load, prior store value, and the hard-coded fallback. */
  readonly merge: (input: MetadataCacheMergeInput<T>) => T;
  /** Freshness window; defaults to one day. */
  readonly ttlMs?: number;
}

/** Arguments passed to a cache merger. */
export interface MetadataCacheMergeInput<T> {
  readonly fresh: T | undefined;
  readonly previous: T | undefined;
  readonly fallback: T;
}

/** One namespaced view over the shared metadata cache. */
export interface MetadataCache<T> {
  /** Return a fresh-or-fallback value, refreshing when stale. */
  get(): Promise<T>;
  /** Read process memory without refreshing. */
  peek(): Promise<T | undefined>;
  /** Mutate the cached value and persist it. */
  update(mutator: (current: T) => T): Promise<T>;
  /** Force a refresh attempt even when the entry is still fresh. */
  refresh(): Promise<T>;
}

/** Create one namespaced view over the shared model metadata cache. */
export function createMetadataCache<T>(
  options: MetadataCacheOptions<T>,
  cache: ReturnType<typeof createCache> = modelMetadataCache,
): MetadataCache<T> {
  const ttlMs = options.ttlMs ?? MODEL_METADATA_TTL_MS;
  const valueKey = `model-metadata:value:${options.key}`;
  const refreshKey = `model-metadata:refresh:${options.key}`;

  const read = (): Promise<T | undefined> => cache.get<T>(valueKey);
  const persist = async (value: T): Promise<T> => {
    await cache.set(valueKey, value);
    return value;
  };
  const resolveValue = (fresh: T | undefined, previous: T | undefined): T =>
    options.merge({ fresh, previous, fallback: options.fallback });

  const refresh = async (force: boolean): Promise<T> => {
    if (force) await cache.delete(refreshKey);
    let staleRefreshFailed = false;
    await getOrSet(
      cache,
      refreshKey,
      async () => {
        const previous = await read();
        let fresh: T | undefined;
        if (options.load) {
          try {
            fresh = await options.load();
          } catch (error) {
            logger.warn("metadata cache refresh failed; using cached or committed value", {
              key: options.key,
              error,
            });
            staleRefreshFailed = previous !== undefined;
          }
        }
        const resolved = resolveValue(fresh, previous);
        if (fresh !== undefined || previous === undefined) await persist(resolved);
        return true;
      },
      { ttl: ttlMs, throwErrors: true },
    );
    if (staleRefreshFailed) await cache.delete(refreshKey);
    return resolveValue(undefined, await read());
  };

  return {
    get: () => refresh(false),
    peek: read,
    refresh: () => refresh(true),
    update: async (mutator) => {
      const value = await persist(mutator(resolveValue(undefined, await read())));
      await cache.set(refreshKey, true, { ttl: ttlMs });
      return value;
    },
  };
}

/** Prefer a non-empty fresh array, else previous, else fallback. */
export function mergePreferFreshList<T>(input: MetadataCacheMergeInput<readonly T[]>): T[] {
  if (input.fresh && input.fresh.length > 0) return [...input.fresh];
  if (input.previous && input.previous.length > 0) return [...input.previous];
  return [...input.fallback];
}

/** Shallow-merge record catalogues: fallback, then previous, then fresh keys. */
export function mergePreferFreshRecord<T>(
  input: MetadataCacheMergeInput<Readonly<Record<string, T>>>,
): Record<string, T> {
  return {
    ...input.fallback,
    ...(input.previous ?? {}),
    ...(input.fresh ?? {}),
  };
}
