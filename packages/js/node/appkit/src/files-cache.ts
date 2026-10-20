/**
 * AppKit-global filesystem cache with user-isolated process-local values.
 *
 * @module
 */

import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { cacheKeys, closeCache, createCache, getOrSet } from "@dbx-tools/cache";
import { log, toError, toStableKey } from "@dbx-tools/shared-core";
import { type CacheValue, type FileSystemCache, normalizeRoot } from "@dbx-tools/shared-fs";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_INVALIDATION_BATCH_MS = 25;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_SCOPES = 256;
const logger = log.logger("files-cache");

interface ScopeState {
  cache: FileSystemCache;
  entries: ReturnType<typeof createCache>;
  group: GroupState;
  scope: ResolvedFilesCacheScope;
  sources: Map<string, Promise<object>>;
}

interface GroupState {
  pending: Set<string>;
  scopes: Set<ScopeState>;
  timer?: ReturnType<typeof setTimeout>;
}

interface ResolvedFilesCacheConfig {
  invalidationBatchMs: number;
  maxEntries: number;
  maxScopes: number;
  ttlMs: number;
}

interface ResolvedFilesCacheScope {
  host: string;
  ttlMs: number;
  userKey: string;
  workspaceId?: string;
}

/** Configuration for the AppKit files-cache plugin. */
export interface FilesCachePluginConfig extends BasePluginConfig {
  /** Default entry TTL in milliseconds. Defaults to 60 seconds. */
  ttlMs?: number;
  /** Invalidation debounce window in milliseconds. Defaults to 25ms. */
  invalidationBatchMs?: number;
  /** Maximum entries retained in each user L1. Defaults to 1,000. */
  maxEntries?: number;
  /** Maximum active user scopes retained by the process. Defaults to 256. */
  maxScopes?: number;
}

/** Identity for one authorization-safe filesystem cache scope. */
export interface FilesCacheScope {
  /** Databricks workspace host. */
  host: string;
  /** Attributed user identifier used to isolate values. */
  userKey: string;
  /** Optional workspace identifier included in shared invalidation scope. */
  workspaceId?: string;
  /** Optional per-scope entry TTL override in milliseconds. */
  ttlMs?: number;
}

/** Stable identity for a framework filesystem source retained within one user scope. */
export interface FilesCacheSourceIdentity {
  /** Actual mounted filesystem paths represented by the source. */
  paths: readonly string[];
  /** Workspace-instance key separating sources with different policies over the same paths. */
  key?: string;
}

/** Public exports from {@link FilesCachePlugin}. */
export interface FilesCacheExports {
  /** Resolve one user-isolated filesystem cache. */
  forScope(scope: FilesCacheScope): Promise<FileSystemCache>;
  /** Resolve one app-lifetime filesystem source for a user and its actual mounted paths. */
  forFileSystem<T extends object>(
    scope: FilesCacheScope,
    identity: FilesCacheSourceIdentity,
    load: () => T | Promise<T>,
  ): Promise<T>;
  /** Flush pending invalidation batches. */
  flush(): Promise<void>;
}

/** Process-local filesystem cache manager. */
export class FilesCacheManager {
  private readonly config: ResolvedFilesCacheConfig;
  private readonly groups = new Map<string, GroupState>();
  private readonly scopes: ReturnType<typeof createCache>;

  constructor(config: FilesCachePluginConfig = {}) {
    this.config = {
      ttlMs: positiveDuration(config.ttlMs, DEFAULT_TTL_MS, "ttlMs"),
      invalidationBatchMs: positiveDuration(
        config.invalidationBatchMs,
        DEFAULT_INVALIDATION_BATCH_MS,
        "invalidationBatchMs",
      ),
      maxEntries: positiveInteger(config.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
      maxScopes: positiveInteger(config.maxScopes, DEFAULT_MAX_SCOPES, "maxScopes"),
    };
    this.scopes = createCache({ maxEntries: this.config.maxScopes, useClone: false });
  }

  /** Return one user-isolated cache within a host/workspace invalidation group. */
  async forScope(input: FilesCacheScope): Promise<FileSystemCache> {
    return (await this.resolveScopeState(input)).cache;
  }

  /** Retain one stable framework filesystem source for the scope and mounted paths. */
  async forFileSystem<T extends object>(
    input: FilesCacheScope,
    identity: FilesCacheSourceIdentity,
    load: () => T | Promise<T>,
  ): Promise<T> {
    const state = await this.resolveScopeState(input);
    const paths = identity.paths.map((path) => normalizeRoot(path));
    if (paths.length === 0) throw new TypeError("Filesystem source paths must not be empty");
    const sourceKey = toStableKey({ paths, key: identity.key });
    let source = state.sources.get(sourceKey);
    if (!source) {
      source = Promise.resolve(load());
      state.sources.set(sourceKey, source);
    }
    try {
      return (await source) as T;
    } catch (error) {
      if (state.sources.get(sourceKey) === source) state.sources.delete(sourceKey);
      throw error;
    }
  }

  private async resolveScopeState(input: FilesCacheScope): Promise<ScopeState> {
    const scope = resolveScope(input, this.config.ttlMs);
    const scopeKey = toStableKey({
      host: scope.host,
      userKey: scope.userKey,
      workspaceId: scope.workspaceId,
    });
    let state = await this.scopes.get<ScopeState>(scopeKey);
    if (!state) {
      if ([...cacheKeys(this.scopes)].length >= this.config.maxScopes) {
        const oldestKey = cacheKeys(this.scopes).next().value;
        if (oldestKey) {
          const oldest = await this.scopes.get<ScopeState>(oldestKey);
          if (oldest) {
            oldest.group.scopes.delete(oldest);
            await closeCache(oldest.entries);
          }
          await this.scopes.delete(oldestKey);
        }
      }
      const group = this.group(scope);
      state = this.createScope(scope, group);
      group.scopes.add(state);
      await this.scopes.set(scopeKey, state);
    }
    return state;
  }

  /** Flush every pending invalidation batch. */
  async flush(): Promise<void> {
    await Promise.all([...this.groups.values()].map((group) => this.flushInvalidations(group)));
  }

  /** Flush state and release all process-local entries and timers. */
  async close(): Promise<void> {
    for (const group of this.groups.values()) {
      if (group.timer) clearTimeout(group.timer);
      group.timer = undefined;
    }
    await this.flush();
    for (const key of cacheKeys(this.scopes)) {
      const state = await this.scopes.get<ScopeState>(key);
      if (state) await closeCache(state.entries);
    }
    await closeCache(this.scopes);
    this.groups.clear();
  }

  private group(scope: ResolvedFilesCacheScope): GroupState {
    const key = toStableKey({
      host: scope.host,
      workspaceId: scope.workspaceId,
    });
    const existing = this.groups.get(key);
    if (existing) return existing;
    const group: GroupState = {
      pending: new Set(),
      scopes: new Set(),
    };
    this.groups.set(key, group);
    return group;
  }

  private createScope(scope: ResolvedFilesCacheScope, group: GroupState): ScopeState {
    const state = {} as ScopeState;
    state.scope = scope;
    state.group = group;
    state.entries = createCache({ maxEntries: this.config.maxEntries, useClone: false });
    state.sources = new Map();
    state.cache = {
      read: <T extends CacheValue>(cacheKey: string, load: () => T | Promise<T>) =>
        this.read(state, cacheKey, load),
      invalidate: (cacheKey: string) => this.queueInvalidation(state, cacheKey),
      keys: () => this.keys(state),
    };
    return state;
  }

  private async read<T extends CacheValue>(
    state: ScopeState,
    key: string,
    load: () => T | Promise<T>,
  ): Promise<T> {
    if (!state.group.pending.has(key)) {
      const retained = await state.entries.get<T>(key);
      if (retained !== undefined) return retained;
    }
    if (state.group.pending.has(key)) {
      const value = await load();
      await state.entries.set(key, value, { ttl: state.scope.ttlMs });
      return value;
    }
    return (await getOrSet(state.entries, key, () => Promise.resolve(load()), {
      ttl: state.scope.ttlMs,
    })) as T;
  }

  private *keys(state: ScopeState): Iterable<string> {
    for (const key of cacheKeys(state.entries)) {
      if (!state.group.pending.has(key)) yield key;
    }
  }

  private queueInvalidation(state: ScopeState, key: string): void {
    state.group.pending.add(key);
    if (state.group.timer) return;
    state.group.timer = setTimeout(() => {
      state.group.timer = undefined;
      void this.flushInvalidations(state.group).catch((error) => {
        logger.warn("filesystem cache invalidation batch failed", {
          error: toError(error),
        });
      });
    }, this.config.invalidationBatchMs);
    state.group.timer.unref?.();
  }

  private async flushInvalidations(group: GroupState): Promise<void> {
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    if (group.pending.size === 0) return;
    const keys = [...group.pending];
    group.pending.clear();
    for (const state of group.scopes) {
      await Promise.all(keys.map((key) => state.entries.delete(key)));
    }
  }
}

/** AppKit plugin that owns process-local filesystem caches. */
export class FilesCachePlugin extends Plugin<FilesCachePluginConfig> {
  static manifest = {
    name: "files-cache",
    displayName: "Files Cache",
    description: "Provides bounded user-scoped process-local filesystem caches.",
    stability: "beta",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"files-cache">;

  private manager?: FilesCacheManager;

  override async setup(): Promise<void> {
    this.manager = new FilesCacheManager(this.config);
    this.context?.onLifecycle("shutdown", () => this.manager?.close());
  }

  override exports(): FilesCacheExports {
    return {
      forScope: (scope) => this.requireManager().forScope(scope),
      forFileSystem: (scope, identity, load) =>
        this.requireManager().forFileSystem(scope, identity, load),
      flush: () => this.requireManager().flush(),
    };
  }

  private requireManager(): FilesCacheManager {
    if (!this.manager) throw new Error("Files cache plugin has not completed setup");
    return this.manager;
  }
}

/** AppKit registration factory for {@link FilesCachePlugin}. */
export const filesCache = toPlugin(FilesCachePlugin);

function resolveScope(input: FilesCacheScope, defaultTtlMs: number): ResolvedFilesCacheScope {
  const host = input.host.trim().replace(/\/+$/, "");
  const userKey = input.userKey.trim();
  const workspaceId = input.workspaceId?.trim() || undefined;
  if (!host) throw new TypeError("Files cache scope host must not be blank");
  if (!userKey) throw new TypeError("Files cache scope userKey must not be blank");
  return {
    host,
    userKey,
    ...(workspaceId ? { workspaceId } : {}),
    ttlMs: positiveDuration(input.ttlMs, defaultTtlMs, "scope.ttlMs"),
  };
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  return Math.floor(positiveDuration(value, fallback, name));
}
