/**
 * Daily model metadata cache built on the shared memory-first cache package.
 *
 * @module
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  closeCache,
  createCache,
  getOrSet,
  projectCache,
  type CacheOptions,
} from "@dbx-tools/cache/cache";
import * as environmentUtils from "@dbx-tools/shared-core/environment-utils";
import * as log from "@dbx-tools/shared-core/log";
import envPaths from "env-paths";

import packageManifest from "../package.json" with { type: "json" };
import { MODEL_METADATA_TTL_MS } from "./_metadata-contract.ts";

const logger = log.logger("model/metadata-cache");

interface PackageIdentity {
  readonly identifier: string;
  readonly version: string;
}

const PACKAGE_IDENTITY: PackageIdentity = {
  identifier: packageManifest.name,
  version: packageManifest.version,
};

/** Envelope persisted for every metadata key. */
export interface MetadataCacheRecord<T> {
  readonly refreshedAt: number;
  readonly value: T;
}

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
  /** Package version segment in the cache path. Defaults to this package. */
  readonly version?: string;
  /** Override the cache root directory, primarily for tests. */
  readonly cacheDir?: string;
  /** Force disk on/off. Defaults to off inside Databricks Apps. */
  readonly disk?: boolean;
  /** Clock override for tests. */
  readonly now?: () => number;
}

/** Arguments passed to a cache merger. */
export interface MetadataCacheMergeInput<T> {
  readonly fresh: T | undefined;
  readonly previous: T | undefined;
  readonly fallback: T;
}

/** One versioned metadata cache. */
export interface MetadataCache<T> {
  /** Absolute cache root for this package version. */
  readonly path: string;
  /** Whether disk persistence is enabled for this instance. */
  readonly diskEnabled: boolean;
  /** Return a fresh-or-fallback value, refreshing when stale. */
  get(): Promise<T>;
  /** Read memory / disk without refreshing. */
  peek(): Promise<T | undefined>;
  /** Mutate the cached value and persist it. */
  update(mutator: (current: T) => T): Promise<T>;
  /** Force a refresh attempt even when the entry is still fresh. */
  refresh(): Promise<T>;
}

interface RegisteredCache {
  readonly cache: ReturnType<typeof createCache>;
  readonly path: string;
}

const registeredCaches = new Set<RegisteredCache>();

/** Default cache root for a package version under the dbx-tools cache dir. */
export function defaultMetadataCacheDir(version: string): string {
  const cacheDirectory = envPaths("dbx-tools", { suffix: "" }).cache;
  return resolve(cacheDirectory, "model-gateway", version);
}

/** Whether metadata caches should persist to disk in this process. */
export function metadataCacheDiskEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !environmentUtils.isDatabricksAppEnv(environment);
}

/** Create one daily cache backed by shared Cacheable memory and optional disk. */
export function createMetadataCache<T>(options: MetadataCacheOptions<T>): MetadataCache<T> {
  const ttlMs = options.ttlMs ?? MODEL_METADATA_TTL_MS;
  const diskEnabled = options.disk ?? metadataCacheDiskEnabled();
  const now = options.now ?? Date.now;
  const path = resolveCacheDir(options);
  const scope = `${options.version ?? PACKAGE_IDENTITY.version}:${options.key}`;
  const cacheOptions: CacheOptions = { maxEntries: 64, useClone: false };
  const cache = diskEnabled
    ? projectCache(scope, {
        ...cacheOptions,
        cacheDir: path,
        projectName: PACKAGE_IDENTITY.identifier,
      })
    : createCache(cacheOptions);
  const registration = { cache, path };
  registeredCaches.add(registration);
  const recordKey = `metadata:${options.key}`;
  const refreshKey = `${recordKey}:refresh`;
  const updateKey = `${recordKey}:update`;

  const readRecord = (): Promise<MetadataCacheRecord<T> | undefined> =>
    cache.get<MetadataCacheRecord<T>>(recordKey);
  const isFresh = (record: MetadataCacheRecord<T> | undefined): boolean =>
    Boolean(record && now() - record.refreshedAt < ttlMs);
  const persist = async (value: T, refreshedAt = now()): Promise<T> => {
    await cache.set(recordKey, { refreshedAt, value });
    return value;
  };
  const resolveValue = (fresh: T | undefined, previous: T | undefined): T =>
    options.merge({ fresh, previous, fallback: options.fallback });

  const refresh = async (force: boolean): Promise<T> => {
    const existing = await readRecord();
    if (!force && isFresh(existing)) return resolveValue(undefined, existing?.value);
    if (force) await cache.delete(refreshKey);
    return (await getOrSet(
      cache,
      refreshKey,
      async () => {
        const previous = await readRecord();
        if (!force && isFresh(previous)) return resolveValue(undefined, previous?.value);
        let fresh: T | undefined;
        if (options.load) {
          try {
            fresh = await options.load();
          } catch (error) {
            logger.warn("metadata cache refresh failed; using cached or committed value", {
              key: options.key,
              error,
              path,
              diskEnabled,
            });
          }
        }
        const value = resolveValue(fresh, previous?.value);
        if (fresh !== undefined || !previous) await persist(value);
        return value;
      },
      { ttl: 1, throwErrors: true },
    ))!;
  };

  return {
    path,
    diskEnabled,
    get: () => refresh(false),
    peek: async () => (await readRecord())?.value,
    refresh: () => refresh(true),
    update: async (mutator) => {
      await cache.delete(updateKey);
      return (await getOrSet(
        cache,
        updateKey,
        async () => {
          const previous = await readRecord();
          return persist(mutator(resolveValue(undefined, previous?.value)));
        },
        { ttl: 1, throwErrors: true },
      ))!;
    },
  };
}

function resolveCacheDir(options: {
  readonly cacheDir?: string;
  readonly version?: string;
}): string {
  if (options.cacheDir) return options.cacheDir;
  return defaultMetadataCacheDir(options.version ?? PACKAGE_IDENTITY.version);
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

/** Test helper: close matching cache instances and wipe their portable disk root. */
export async function resetMetadataCacheDir(cacheDir: string): Promise<void> {
  const resolved = resolve(cacheDir);
  for (const registration of [...registeredCaches]) {
    if (resolve(registration.path) !== resolved) continue;
    await closeCache(registration.cache);
    registeredCaches.delete(registration);
  }
  await rm(resolved, { force: true, recursive: true });
}
