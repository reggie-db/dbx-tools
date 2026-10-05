/**
 * Agnostic daily metadata cache on {@link https://www.npmjs.com/package/cacache | cacache}.
 *
 * Uses cacache's built-in memory memoization (`memoize: true` on put; gets read
 * the in-memory layer by default) with content-addressed disk under
 * `env-paths("dbx-tools").cache/model-gateway/<version>/`. Disk persistence is
 * disabled inside a Databricks App ({@link environmentUtils.isDatabricksAppEnv});
 * those processes keep a process-local Map only.
 *
 * Each cache owns a key, hard-coded fallback, optional network loader, and a
 * merger that combines fresh / previous / fallback values. Freshness is the
 * envelope `refreshedAt` window (default one day), not cacache's short LRU TTL.
 *
 * @module
 */

import { resolve } from "node:path";

import * as environmentUtils from "@dbx-tools/shared-core/environment-utils";
import * as log from "@dbx-tools/shared-core/log";
import cacache from "cacache";
import envPaths from "env-paths";

import { MODEL_METADATA_TTL_MS } from "./_metadata-contract.ts";

const logger = log.logger("model/metadata-cache");

/** Envelope stored as JSON bytes in cacache for every key. */
export interface MetadataCacheRecord<T> {
  readonly refreshedAt: number;
  readonly value: T;
}

/** Factory inputs for one named metadata cache. */
export interface MetadataCacheOptions<T> {
  /** Stable cacache key. */
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
  /**
   * Force disk on/off. Defaults to off inside Databricks Apps, on otherwise.
   */
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

/** One versioned metadata cache (cacache memory + optional disk). */
export interface MetadataCache<T> {
  /** Absolute cacache root for this package version (unused when disk is off). */
  readonly path: string;
  /** Whether cacache disk persistence is enabled for this instance. */
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

const inflight = new Map<string, Promise<unknown>>();

/** Default cacache root for a package version under the dbx-tools cache dir. */
export function defaultMetadataCacheDir(version: string): string {
  const cacheDirectory = envPaths("dbx-tools", { suffix: "" }).cache;
  return resolve(cacheDirectory, "model-gateway", version);
}

/** Whether metadata caches should persist to disk in this process. */
export function metadataCacheDiskEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !environmentUtils.isDatabricksAppEnv(environment);
}

/**
 * Create one daily cache backed by cacache memoization, with optional disk.
 */
export function createMetadataCache<T>(options: MetadataCacheOptions<T>): MetadataCache<T> {
  const ttlMs = options.ttlMs ?? MODEL_METADATA_TTL_MS;
  const diskEnabled = options.disk ?? metadataCacheDiskEnabled();
  const now = options.now ?? Date.now;
  const pathPromise = resolveCacheDir(options);
  let path = options.cacheDir;

  const flightKey = (cachePath: string, suffix = ""): string =>
    `${cachePath}::${options.key}${suffix}`;

  /** Process-local store used when disk is off (Databricks Apps). */
  const memoryOnly = new Map<string, MetadataCacheRecord<T>>();

  const resolveValue = (input: MetadataCacheMergeInput<T>): T => options.merge(input);

  const isFresh = (record: MetadataCacheRecord<T> | undefined): boolean =>
    Boolean(record && now() - record.refreshedAt < ttlMs);

  const cachePath = async (): Promise<string> => {
    path ??= await pathPromise;
    return path;
  };

  const readRecord = async (): Promise<MetadataCacheRecord<T> | undefined> => {
    if (!diskEnabled) return memoryOnly.get(options.key);
    const resolvedPath = await cachePath();
    try {
      // cacache reads its in-memory memo first unless memoize is false
      const entry = await cacache.get(resolvedPath, options.key);
      return decodeRecord<T>(entry.data);
    } catch (error) {
      if (isCacheMiss(error)) return undefined;
      logger.warn("metadata cache cacache read failed", {
        key: options.key,
        path: resolvedPath,
        error,
      });
      return undefined;
    }
  };

  const writeRecord = async (record: MetadataCacheRecord<T>): Promise<void> => {
    if (!diskEnabled) {
      memoryOnly.set(options.key, record);
      return;
    }
    const resolvedPath = await cachePath();
    try {
      await cacache.put(resolvedPath, options.key, `${JSON.stringify(record)}\n`, {
        memoize: true,
        metadata: { refreshedAt: record.refreshedAt },
      });
    } catch (error) {
      logger.warn("metadata cache cacache write failed", {
        key: options.key,
        path: resolvedPath,
        error,
      });
    }
  };

  const persist = async (value: T, refreshedAt = now()): Promise<T> => {
    await writeRecord({ refreshedAt, value });
    return value;
  };

  const refresh = async (force: boolean): Promise<T> => {
    const resolvedPath = await cachePath();
    return coalesce(flightKey(resolvedPath), async () => {
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
            path: resolvedPath,
            diskEnabled,
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
  };

  return {
    get path() {
      if (!path) {
        throw new Error("metadata cache path is not resolved until the first cache read");
      }
      return path;
    },
    diskEnabled,
    get: () => refresh(false),
    peek: async () => (await readRecord())?.value,
    refresh: () => refresh(true),
    update: async (mutator) => {
      const resolvedPath = await cachePath();
      return coalesce(flightKey(resolvedPath, ":update"), async () => {
        const previous = await readRecord();
        const baseline = resolveValue({
          fresh: undefined,
          previous: previous?.value,
          fallback: options.fallback,
        });
        return persist(mutator(baseline));
      });
    },
  };
}

async function resolveCacheDir(options: {
  readonly cacheDir?: string;
  readonly version?: string;
}): Promise<string> {
  if (options.cacheDir) return options.cacheDir;
  const version = options.version ?? (await import("../index.ts")).PACKAGE_VERSION;
  return defaultMetadataCacheDir(version);
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

/** Test helper: wipe a cacache root and clear cacache memoization. */
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

function coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = work().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

function decodeRecord<T>(data: Buffer): MetadataCacheRecord<T> | undefined {
  try {
    const parsed = JSON.parse(data.toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as MetadataCacheRecord<T>).refreshedAt !== "number"
    ) {
      return undefined;
    }
    return parsed as MetadataCacheRecord<T>;
  } catch {
    return undefined;
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

