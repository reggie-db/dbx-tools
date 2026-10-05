/**
 * Agnostic daily metadata cache backed by {@link https://www.npmjs.com/package/cacache | cacache}.
 *
 * Hot reads use cacache's in-memory memoization (`memoize: true` on write;
 * reads hit memory by default). Misses and mutations also persist under
 * `env-paths("dbx-tools").cache/model-gateway/<version>/` so restarts reuse
 * the last good payload for one day (or a custom TTL).
 *
 * Each cache owns a key, hard-coded fallback, optional network loader, and a
 * merger that combines fresh / previous / fallback values.
 *
 * @module
 */

import { resolve } from "node:path";

import * as log from "@dbx-tools/shared-core/log";
import cacache from "cacache";
import envPaths from "env-paths";

import packageJson from "../package.json" with { type: "json" };
import { MODEL_METADATA_TTL_MS } from "./_metadata-contract.ts";

const logger = log.logger("model/metadata-cache");

/** Envelope stored as JSON bytes in cacache for every key. */
export interface MetadataCacheRecord<T> {
  readonly refreshedAt: number;
  readonly value: T;
}

/** Factory inputs for one named metadata cache. */
export interface MetadataCacheOptions<T> {
  /** Stable cacache key (also used for in-flight coalescing). */
  readonly key: string;
  /** Hard-coded / committed baseline used when store and load both miss. */
  readonly fallback: T;
  /**
   * Refresh source. When omitted the cache only serves store + fallback and
   * {@link MetadataCache.update} mutations (for example error-learned values).
   */
  readonly load?: () => Promise<T>;
  /** Combine a fresh load, prior store value, and the hard-coded fallback. */
  readonly merge: (input: MetadataCacheMergeInput<T>) => T;
  /** Freshness window; defaults to {@link MODEL_METADATA_TTL_MS} (one day). */
  readonly ttlMs?: number;
  /** Package version segment in the cache path. Defaults to this package. */
  readonly version?: string;
  /** Override the cacache root directory (tests). */
  readonly cacheDir?: string;
  /** Clock override for tests. */
  readonly now?: () => number;
}

/** Arguments passed to a cache merger. */
export interface MetadataCacheMergeInput<T> {
  readonly fresh: T | undefined;
  readonly previous: T | undefined;
  readonly fallback: T;
}

/** One versioned, write-through metadata cache. */
export interface MetadataCache<T> {
  /** Absolute cacache root for this package version. */
  readonly path: string;
  /** Return a fresh-or-fallback value, refreshing when stale. */
  get(): Promise<T>;
  /** Read memory / disk without refreshing. */
  peek(): Promise<T | undefined>;
  /** Mutate the cached value and persist it. */
  update(mutator: (current: T) => T): Promise<T>;
  /** Force a refresh attempt even when the entry is still fresh. */
  refresh(): Promise<T>;
}

const inflight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = work().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

/** Default cacache root for a package version under the dbx-tools cache dir. */
export function defaultMetadataCacheDir(version = packageJson.version): string {
  const cacheDirectory = envPaths("dbx-tools", { suffix: "" }).cache;
  return resolve(cacheDirectory, "model-gateway", version);
}

/**
 * Create one daily write-through cache backed by cacache (disk) with memory
 * memoization on top.
 */
export function createMetadataCache<T>(options: MetadataCacheOptions<T>): MetadataCache<T> {
  const ttlMs = options.ttlMs ?? MODEL_METADATA_TTL_MS;
  const version = options.version ?? packageJson.version;
  const path = options.cacheDir ?? defaultMetadataCacheDir(version);
  const now = options.now ?? Date.now;
  const flightKey = `${path}::${options.key}`;

  const resolveValue = (input: MetadataCacheMergeInput<T>): T => options.merge(input);

  const readRecord = async (): Promise<MetadataCacheRecord<T> | undefined> => {
    try {
      const entry = await cacache.get(path, options.key);
      const parsed = JSON.parse(entry.data.toString("utf8")) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as MetadataCacheRecord<T>).refreshedAt !== "number"
      ) {
        return undefined;
      }
      return parsed as MetadataCacheRecord<T>;
    } catch (error) {
      if (isCacheMiss(error)) return undefined;
      logger.warn("metadata cache cacache read failed", { key: options.key, path, error });
      return undefined;
    }
  };

  const writeRecord = async (record: MetadataCacheRecord<T>): Promise<void> => {
    try {
      await cacache.put(path, options.key, `${JSON.stringify(record)}\n`, {
        memoize: true,
        metadata: { refreshedAt: record.refreshedAt },
      });
    } catch (error) {
      logger.warn("metadata cache cacache write failed", { key: options.key, path, error });
    }
  };

  const isFresh = (record: MetadataCacheRecord<T> | undefined): boolean =>
    Boolean(record && now() - record.refreshedAt < ttlMs);

  const persist = async (value: T, refreshedAt = now()): Promise<T> => {
    await writeRecord({ refreshedAt, value });
    return value;
  };

  const refresh = async (force: boolean): Promise<T> =>
    coalesce(flightKey, async () => {
      const previous = await readRecord();
      if (!force && isFresh(previous)) {
        return resolveValue({
          fresh: undefined,
          previous: previous?.value,
          fallback: options.fallback,
        });
      }

      let fresh: T | undefined;
      if (options.load) {
        try {
          fresh = await options.load();
        } catch (error) {
          logger.warn("metadata cache refresh failed; keeping last known good", {
            key: options.key,
            error,
            path,
          });
        }
      }

      const value = resolveValue({
        fresh,
        previous: previous?.value,
        fallback: options.fallback,
      });
      if (fresh !== undefined || !previous) {
        await persist(value);
      }
      return value;
    });

  return {
    path,
    get: () => refresh(false),
    peek: async () => (await readRecord())?.value,
    refresh: () => refresh(true),
    update: async (mutator) =>
      coalesce(`${flightKey}:update`, async () => {
        const previous = await readRecord();
        const baseline = resolveValue({
          fresh: undefined,
          previous: previous?.value,
          fallback: options.fallback,
        });
        return persist(mutator(baseline));
      }),
  };
}

/** Prefer a non-empty fresh array, else previous, else fallback. */
export function mergePreferFreshList<T>(input: MetadataCacheMergeInput<readonly T[]>): T[] {
  if (input.fresh && input.fresh.length > 0) return [...input.fresh];
  if (input.previous && input.previous.length > 0) return [...input.previous];
  return [...input.fallback];
}

/**
 * Shallow-merge record catalogues: fallback, then previous, then fresh keys.
 * Fresh values win per key.
 */
export function mergePreferFreshRecord<T>(
  input: MetadataCacheMergeInput<Readonly<Record<string, T>>>,
): Record<string, T> {
  return {
    ...input.fallback,
    ...(input.previous ?? {}),
    ...(input.fresh ?? {}),
  };
}

/** Test helper: wipe a cacache root and clear process memoization. */
export async function resetMetadataCacheDir(cacheDir: string): Promise<void> {
  try {
    await cacache.rm.all(cacheDir);
  } catch {
    // empty / missing cache is fine
  }
  cacache.clearMemoized();
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(`${cacheDir}::`)) inflight.delete(key);
  }
}

function isCacheMiss(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
