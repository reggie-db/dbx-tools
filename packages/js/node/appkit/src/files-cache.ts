/**
 * AppKit-global filesystem cache with user-isolated process-local LRU values.
 *
 * @module
 */

import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { posixPath, type CacheValue, type FileSystemCache } from "@dbx-tools/shared-fs";
import { errorUtils, log, object } from "@dbx-tools/shared-core";
import { LRUCache } from "lru-cache";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_INVALIDATION_BATCH_MS = 25;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCOPES = 256;
const logger = log.logger("files-cache");

interface RetainedEntry {
  value: CacheValue;
}

interface ScopeState {
  cache: FileSystemCache;
  entries: LRUCache<string, RetainedEntry>;
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
  maxBytes: number;
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
  /** Maximum retained bytes in each user L1. Defaults to 64 MiB. */
  maxBytes?: number;
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
  private readonly scopes: LRUCache<string, ScopeState>;

  constructor(config: FilesCachePluginConfig = {}) {
    this.config = {
      ttlMs: positiveDuration(config.ttlMs, DEFAULT_TTL_MS, "ttlMs"),
      invalidationBatchMs: positiveDuration(
        config.invalidationBatchMs,
        DEFAULT_INVALIDATION_BATCH_MS,
        "invalidationBatchMs",
      ),
      maxEntries: positiveInteger(config.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
      maxBytes: positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
      maxScopes: positiveInteger(config.maxScopes, DEFAULT_MAX_SCOPES, "maxScopes"),
    };
    this.scopes = new LRUCache({
      max: this.config.maxScopes,
      dispose: (state) => {
        state.group.scopes.delete(state);
      },
    });
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
    const paths = identity.paths.map((path) => posixPath.normalizeRoot(path));
    if (paths.length === 0) throw new TypeError("Filesystem source paths must not be empty");
    const sourceKey = object.toStableKey({ paths, key: identity.key });
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
    const scopeKey = object.toStableKey({
      host: scope.host,
      userKey: scope.userKey,
      workspaceId: scope.workspaceId,
    });
    let state = this.scopes.get(scopeKey);
    if (!state) {
      const group = this.group(scope);
      state = this.createScope(scope, group);
      group.scopes.add(state);
      this.scopes.set(scopeKey, state);
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
    this.scopes.clear();
    this.groups.clear();
  }

  private group(scope: ResolvedFilesCacheScope): GroupState {
    const key = object.toStableKey({
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
    state.entries = new LRUCache({
      max: this.config.maxEntries,
      maxSize: this.config.maxBytes,
      sizeCalculation: (entry, cacheKey) => retainedSize(cacheKey, entry),
    });
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
      const retained = state.entries.get(key);
      if (retained) return retained.value as T;
    }
    const value = await load();
    state.entries.set(key, { value }, { ttl: state.scope.ttlMs });
    return value;
  }

  private *keys(state: ScopeState): Iterable<string> {
    for (const key of state.entries.keys()) {
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
          error: errorUtils.errorMessage(error),
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
      for (const key of keys) state.entries.delete(key);
    }
  }
}

/** AppKit plugin that owns process-local filesystem LRU caches. */
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

function retainedSize(key: string, entry: RetainedEntry): number {
  try {
    return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(entry.value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
