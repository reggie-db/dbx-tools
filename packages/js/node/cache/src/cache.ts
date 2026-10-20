/**
 * Memory-first Cacheable and Keyv composition.
 *
 * @module
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { projectUtils } from "@dbx-tools/core";
import { errorUtils, log } from "@dbx-tools/shared-core";
import {
  Cacheable,
  CacheableHooks,
  KeyvCacheableMemory,
  type CacheableOptions,
  type GetOrSetFunctionOptions,
  type KeyvStoreAdapter,
} from "cacheable";
import envPaths from "env-paths";
import { Keyv } from "keyv";
import { KeyvFile } from "keyv-file";

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_WRITE_DELAY_MS = 25;
const ERROR_VALUE_PREFIX = "__dbx_tools_cached_on_error__:";
const ENVELOPE_VERSION = 1;
const logger = log.logger("cache");

interface ValueEnvelope {
  readonly __dbxToolsCacheEnvelope: typeof ENVELOPE_VERSION;
  readonly value: unknown;
}

interface SetMutation {
  readonly kind: "set";
  readonly ttl?: number;
  readonly value: unknown;
}

interface DeleteMutation {
  readonly kind: "delete";
}

type Mutation = DeleteMutation | SetMutation;

interface CacheState {
  readonly adapter?: TieredStoreAdapter;
  path?: string;
  registryKey?: string;
  closed: boolean;
}

/** One ordered persistent cache level. Earlier levels are read first. */
export interface CacheLevel {
  /** Optional name included in persistence error messages. */
  readonly name?: string;
  /** Keyv-compatible store adapter. */
  readonly store: KeyvStoreAdapter;
}

/** Options for an AppKit-independent memory-first cache. */
export interface CacheOptions extends Pick<
  CacheableOptions,
  "cacheId" | "maxTtl" | "namespace" | "stats" | "tags" | "ttl"
> {
  /** Additional ordered persistence levels. No levels creates a memory-only cache. */
  readonly levels?: readonly CacheLevel[];
  /** Maximum entries retained in the memory primary. Defaults to 1,000. */
  readonly maxEntries?: number;
  /** Whether memory reads clone values. Defaults to true. */
  readonly useClone?: boolean;
  /** Delay used to coalesce persistence mutations. Defaults to 25 milliseconds. */
  readonly writeDelayMs?: number;
}

/** Options for the default project-scoped memory and disk cache. */
export interface ProjectCacheOptions extends CacheOptions {
  /** Override the cache directory, primarily for tests. */
  readonly cacheDir?: string;
  /** Disable the default disk level. Defaults to true. */
  readonly disk?: boolean;
  /** Delay used by keyv-file to coalesce file rewrites. Defaults to 100 milliseconds. */
  readonly diskWriteDelayMs?: number;
  /** Override the project name resolved through projectUtils.name(). */
  readonly projectName?: string;
}

/** Options for the Cacheable-compatible get-or-set extension. */
export interface GetOrSetOptions extends GetOrSetFunctionOptions {
  /** Return a separately retained successful value when the loader fails. Defaults to false. */
  readonly returnCachedOnError?: boolean;
  /** TTL for the cached-on-error value. Defaults to 0, meaning no expiration. */
  readonly cachedOnErrorTtl?: number | string;
}

const states = new WeakMap<Cacheable, CacheState>();
const projectCaches = new Map<string, Cacheable>();

/**
 * Keyv adapter that composes arbitrary ordered levels behind Cacheable's one
 * secondary-store slot and owns tracked write-behind persistence.
 */
class TieredStoreAdapter extends EventEmitter implements KeyvStoreAdapter {
  readonly opts = {};
  namespace?: string;

  private readonly levels: readonly CacheLevel[];
  private readonly pending = new Map<string, Mutation>();
  private readonly promotions = new Set<Promise<void>>();
  private readonly writeDelayMs: number;
  private flushPromise?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private disconnected = false;

  constructor(levels: readonly CacheLevel[], writeDelayMs: number) {
    super();
    this.levels = levels;
    this.writeDelayMs = writeDelayMs;
  }

  async get<Value>(key: string): Promise<Value | undefined> {
    const mutation = this.pending.get(key);
    if (mutation?.kind === "delete") return undefined;
    if (mutation?.kind === "set") return mutation.value as Value;

    for (const [index, level] of this.levels.entries()) {
      const value = await level.store.get<Value>(key);
      if (value === undefined) continue;
      if (index > 0) this.promote(key, value, this.levels.slice(0, index));
      return value as Value;
    }
    return undefined;
  }

  async getMany<Value>(keys: string[]): Promise<Array<Value | undefined>> {
    return Promise.all(keys.map((key) => this.get<Value>(key)));
  }

  set(key: string, value: unknown, ttl?: number): Promise<boolean> {
    this.assertConnected();
    this.pending.set(key, { kind: "set", value, ...(ttl === undefined ? {} : { ttl }) });
    this.schedule();
    return Promise.resolve(true);
  }

  async setMany(values: Array<{ key: string; value: unknown; ttl?: number }>): Promise<void> {
    for (const entry of values) await this.set(entry.key, entry.value, entry.ttl);
  }

  delete(key: string): Promise<boolean> {
    this.assertConnected();
    this.pending.set(key, { kind: "delete" });
    this.schedule();
    return Promise.resolve(true);
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    await Promise.all(keys.map((key) => this.delete(key)));
    return true;
  }

  async has(key: string): Promise<boolean> {
    const pending = this.pending.get(key);
    if (pending) return pending.kind === "set";
    for (const level of this.levels) {
      if (
        level.store.has ? await level.store.has(key) : (await level.store.get(key)) !== undefined
      ) {
        return true;
      }
    }
    return false;
  }

  async clear(): Promise<void> {
    this.assertConnected();
    await this.flush();
    this.pending.clear();
    await settleLevels(this.levels, (level) => level.store.clear(), "clear");
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.flushPromise) {
      this.flushPromise = this.flushPending().finally(() => {
        this.flushPromise = undefined;
      });
    }
    await this.flushPromise;
    await this.flushPromotions();
    if (this.pending.size > 0) await this.flush();
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    await this.flush();
    this.disconnected = true;
    await settleLevels(
      this.levels.filter((level) => level.store.disconnect),
      (level) => level.store.disconnect!(),
      "disconnect",
    );
  }

  private assertConnected(): void {
    if (this.disconnected) throw new Error("Cache persistence is disconnected");
  }

  private schedule(): void {
    if (this.timer || this.flushPromise) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        logger.warn("cache persistence flush failed", { error: errorUtils.toError(error) });
        this.emit("error", error);
      });
    }, this.writeDelayMs);
    this.timer.unref?.();
  }

  private async flushPending(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = new Map(this.pending);
      for (const key of batch.keys()) this.pending.delete(key);
      const failures: Array<{ key: string; mutation: Mutation; error: unknown }> = [];
      await Promise.all(
        [...batch].map(async ([key, mutation]) => {
          try {
            await settleLevels(
              this.levels,
              (level) =>
                mutation.kind === "set"
                  ? level.store.set(key, mutation.value, mutation.ttl)
                  : level.store.delete(key),
              mutation.kind,
            );
          } catch (error) {
            failures.push({ key, mutation, error });
          }
        }),
      );
      if (failures.length > 0) {
        for (const failure of failures) {
          if (!this.pending.has(failure.key)) this.pending.set(failure.key, failure.mutation);
        }
        throw new AggregateError(
          failures.map((failure) => failure.error),
          `Cache persistence failed for ${failures.length} mutation(s)`,
        );
      }
    }
  }

  private promote(key: string, value: unknown, levels: readonly CacheLevel[]): void {
    const promotion = settleLevels(levels, (level) => level.store.set(key, value), "promote")
      .catch((error) => {
        logger.warn("cache persistence promotion failed", {
          key,
          error: errorUtils.toError(error),
        });
      })
      .finally(() => {
        this.promotions.delete(promotion);
      });
    this.promotions.add(promotion);
  }

  private async flushPromotions(): Promise<void> {
    while (this.promotions.size > 0) await Promise.all([...this.promotions]);
  }
}

/** Create a memory-first cache with optional ordered persistent levels. */
export function createCache(options: CacheOptions = {}): Cacheable {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const writeDelayMs = nonNegativeInteger(
    options.writeDelayMs,
    DEFAULT_WRITE_DELAY_MS,
    "writeDelayMs",
  );
  const primary = new Keyv({
    store: new KeyvCacheableMemory({
      lruSize: maxEntries,
      ttl: options.ttl,
      useClone: options.useClone ?? true,
    }),
    ...(typeof options.ttl === "number" && Number.isInteger(options.ttl)
      ? { ttl: options.ttl }
      : {}),
  });
  primary.serialize = undefined;
  primary.deserialize = undefined;
  const adapter = options.levels?.length
    ? new TieredStoreAdapter(options.levels, writeDelayMs)
    : undefined;
  const secondary = adapter ? new Keyv({ store: adapter }) : undefined;
  const cache = new Cacheable({
    primary,
    ...(secondary ? { secondary, nonBlocking: true } : {}),
    ...(options.cacheId === undefined ? {} : { cacheId: options.cacheId }),
    ...(options.maxTtl === undefined ? {} : { maxTtl: options.maxTtl }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    ...(options.stats === undefined ? {} : { stats: options.stats }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
  });
  installValueEnvelope(cache);
  cache.on("error", (error) => {
    logger.warn("cacheable operation failed", { error: errorUtils.toError(error) });
  });
  states.set(cache, { adapter, closed: false });
  return cache;
}

/** Resolve the default portable disk path for a project cache scope. */
export function cachePath(
  scope: string,
  options: Pick<ProjectCacheOptions, "cacheDir" | "projectName"> = {},
): string {
  const projectName = options.projectName ?? projectUtils.name();
  const root = options.cacheDir ?? envPaths("dbx-tools", { suffix: "" }).cache;
  return join(root, "cache", safeSegment(projectName), `${safeSegment(scope)}.json`);
}

/**
 * Return a process-shared project cache. By default it is memory-first with a
 * portable keyv-file secondary scoped by project and logical cache name.
 */
export function projectCache(scope: string, options: ProjectCacheOptions = {}): Cacheable {
  const path = cachePath(scope, options);
  const registryKey = JSON.stringify([path, options.disk !== false]);
  const existing = projectCaches.get(registryKey);
  if (existing) return existing;

  const levels = [...(options.levels ?? [])];
  if (options.disk !== false) {
    levels.push({
      name: "disk",
      store: new KeyvFile({
        filename: path,
        writeDelay: nonNegativeInteger(options.diskWriteDelayMs, 100, "diskWriteDelayMs"),
      }),
    });
  }
  const cache = createCache({ ...options, levels });
  const state = requireState(cache);
  state.path = path;
  state.registryKey = registryKey;
  projectCaches.set(registryKey, cache);
  return cache;
}

/** Wait for all tracked write-behind persistence without closing the cache. */
export async function flushCache(cache: Cacheable): Promise<void> {
  await requireState(cache).adapter?.flush();
}

/** Flush pending persistence and disconnect all cache levels. Idempotent. */
export async function closeCache(cache: Cacheable): Promise<void> {
  const state = requireState(cache);
  if (state.closed) return;
  await state.adapter?.disconnect();
  state.closed = true;
  if (state.registryKey && projectCaches.get(state.registryKey) === cache) {
    projectCaches.delete(state.registryKey);
  }
}

/** Iterate keys currently retained by the bounded memory primary. */
export function cacheKeys(cache: Cacheable): IterableIterator<string> {
  const store = cache.primary.store;
  if (!(store instanceof KeyvCacheableMemory)) {
    throw new TypeError("Cache primary is not Cacheable memory");
  }
  return store.store.keys;
}

/** Delete a normal cache value and its optional cached-on-error companion. */
export async function deleteCachedValue(cache: Cacheable, key: string): Promise<boolean> {
  const [value, fallback] = await Promise.all([
    cache.delete(key),
    cache.delete(cachedOnErrorKey(key)),
  ]);
  return Boolean(value || fallback);
}

/**
 * Use Cacheable's native in-flight get-or-set behavior, optionally retaining a
 * successful value under a separate key for recovery when a later loader fails.
 */
export async function getOrSet<T>(
  cache: Cacheable,
  key: string,
  load: () => Promise<T>,
  options: GetOrSetOptions = {},
): Promise<T | undefined> {
  const { returnCachedOnError = false, cachedOnErrorTtl = 0, ...cacheableOptions } = options;
  if (!returnCachedOnError) return cache.getOrSet(key, load, cacheableOptions);

  try {
    return await cache.getOrSet(
      key,
      async () => {
        const value = await load();
        await cache.set(cachedOnErrorKey(key), value, { ttl: cachedOnErrorTtl });
        return value;
      },
      { ...cacheableOptions, throwErrors: true },
    );
  } catch (error) {
    const cached = await cache.get<T>(cachedOnErrorKey(key));
    if (cached !== undefined) return cached;
    if (cacheableOptions.throwErrors) throw error;
    return undefined;
  }
}

function installValueEnvelope(cache: Cacheable): void {
  cache.onHook(CacheableHooks.BEFORE_SET, (item) => {
    item.value = envelope(item.value);
  });
  cache.onHook(CacheableHooks.BEFORE_SET_MANY, (items) => {
    for (const item of items) item.value = envelope(item.value);
  });
  cache.onHook(CacheableHooks.AFTER_GET, (item) => {
    if (item.result) item.result.value = unwrap(item.result.value);
  });
  cache.onHook(CacheableHooks.AFTER_GET_MANY, (item) => {
    for (const result of item.result) {
      if (result) result.value = unwrap(result.value);
    }
  });
}

function envelope(value: unknown): ValueEnvelope {
  return { __dbxToolsCacheEnvelope: ENVELOPE_VERSION, value };
}

function unwrap(value: unknown): unknown {
  return isEnvelope(value) ? value.value : value;
}

function isEnvelope(value: unknown): value is ValueEnvelope {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__dbxToolsCacheEnvelope" in value &&
    (value as ValueEnvelope).__dbxToolsCacheEnvelope === ENVELOPE_VERSION &&
    "value" in value,
  );
}

function cachedOnErrorKey(key: string): string {
  return `${ERROR_VALUE_PREFIX}${key}`;
}

async function settleLevels(
  levels: readonly CacheLevel[],
  operation: (level: CacheLevel) => unknown | Promise<unknown>,
  operationName: string,
): Promise<void> {
  const results = await Promise.allSettled(levels.map((level) => operation(level)));
  const errors = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          new Error(`${levels[index]?.name ?? `level-${index + 1}`} ${operationName} failed`, {
            cause: result.reason,
          }),
        ]
      : [],
  );
  if (errors.length > 0) throw new AggregateError(errors, `Cache ${operationName} failed`);
}

function requireState(cache: Cacheable): CacheState {
  const state = states.get(cache);
  if (!state) throw new TypeError("Cache was not created by @dbx-tools/cache");
  return state;
}

function safeSegment(value: string): string {
  return encodeURIComponent(value.trim() || "default");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return resolved;
}
