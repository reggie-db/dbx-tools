/**
 * Memory-first AppKit cache storage with soft-fail Lakebase persistence.
 *
 * AppKit's `PersistentStorage.initialize()` runs DDL migrations and throws on
 * any step failure. With `cache.strictPersistence: true` that throw makes
 * `CacheManager` silently disable the cache. This wraps the same storage,
 * still runs its migrations, but logs a failed step instead of throwing so a
 * usable table keeps serving.
 *
 * `PersistentStorage` is not on AppKit's public export map. The deep load is
 * lazy and best-effort: if the installed AppKit layout changes, Lakebase is
 * skipped and the adapter keeps its project-scoped disk persistence.
 *
 * @module
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createLakebasePool, type CacheConfig } from "@databricks/appkit";
import {
  closeCache,
  createCache,
  flushCache,
  projectCache,
  type CacheOptions,
} from "@dbx-tools/cache";
import { postgresConnectionOptions } from "@dbx-tools/postgres";
import { log, toError, id } from "@dbx-tools/shared-core";
import { handleOwnershipMigrationError } from "./migration.ts";
import { createWorkspaceClient } from "./databricks.ts";

const logger = log.logger("cache-storage");

type LakebasePool = ReturnType<typeof createLakebasePool>;
type CacheStorage = NonNullable<CacheConfig["storage"]>;

interface CacheEntry<T = unknown> {
  expiry: number;
  value: T;
}

/** Options for AppKit's memory-first cache storage adapter. */
export interface AppKitCacheStorageOptions {
  /** Native AppKit cache configuration. */
  cache?: CacheConfig;
  /** Whether to attempt AppKit's Lakebase PersistentStorage. Defaults to true. */
  preferLakebase?: boolean;
  /** Portable disk scope used when Lakebase is unavailable. */
  diskScope?: string;
  /** Write-behind coalescing delay in milliseconds. */
  writeDelayMs?: number;
  /** Maximum entries retained in the process-local memory primary. */
  maxEntries?: number;
}

/** AppKit's internal persistent storage surface. */
export type PersistentStorageBase = CacheStorage & {
  cleanupExpired?(): Promise<number>;
  initialize(): Promise<void>;
  initialized: boolean;
  schemaName?: string;
  tableName?: string;
};

type PersistentStorageConstructor = new (
  config: CacheConfig,
  pool: LakebasePool,
) => PersistentStorageBase;

let persistentStorageCtor: PersistentStorageConstructor | undefined | null = null;

class AppKitStorageLevel extends EventEmitter {
  readonly opts = {};

  constructor(private readonly storage: CacheStorage) {
    super();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = await this.storage.get<T>(key);
    if (!entry) return undefined;
    if (entry.expiry <= Date.now()) {
      await this.storage.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.storage.set(key, {
      value,
      expiry: Date.now() + (ttl ?? 60_000),
    });
  }

  async delete(key: string): Promise<boolean> {
    await this.storage.delete(key);
    return true;
  }

  clear(): Promise<void> {
    return this.storage.clear();
  }

  has(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  disconnect(): Promise<void> {
    return this.storage.close();
  }
}

/** Memory-first AppKit CacheStorage backed by @dbx-tools/cache. */
export class AppKitCacheStorage implements CacheStorage {
  private readonly cache: ReturnType<typeof createCache>;
  private readonly keys = new Set<string>();
  private closed = false;

  constructor(
    cache: ReturnType<typeof createCache>,
    private readonly persistent: CacheStorage | undefined,
  ) {
    this.cache = cache;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = await this.cache.get<CacheEntry<T>>(key);
    if (!entry) return null;
    this.keys.add(key);
    return entry;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const ttl = entry.expiry - Date.now();
    if (ttl <= 0) {
      await this.delete(key);
      return;
    }
    await this.cache.set(key, entry, { ttl });
    this.keys.add(key);
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(key);
    this.keys.delete(key);
  }

  async clear(): Promise<void> {
    await this.cache.clear();
    this.keys.clear();
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async size(): Promise<number> {
    return this.persistent ? this.persistent.size() : this.keys.size;
  }

  isPersistent(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    return this.persistent ? this.persistent.healthCheck() : true;
  }

  /** Drain tracked write-behind persistence without closing the storage. */
  flush(): Promise<void> {
    return flushCache(this.cache);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await closeCache(this.cache);
    this.closed = true;
    this.keys.clear();
  }

  /** Forward AppKit's runtime-only persistent cleanup hook when available. */
  async cleanupExpired(): Promise<number> {
    const cleanup = (
      this.persistent as
        | (CacheStorage & {
            cleanupExpired?: () => Promise<number>;
          })
        | undefined
    )?.cleanupExpired;
    return cleanup && this.persistent ? cleanup.call(this.persistent) : 0;
  }
}

/**
 * Lazily resolve AppKit's internal `PersistentStorage` constructor. `null`
 * means not attempted yet; `undefined` means the lookup already failed.
 */
export function loadPersistentStorage(): PersistentStorageConstructor | undefined {
  if (persistentStorageCtor !== null) {
    return persistentStorageCtor;
  }
  try {
    const require = createRequire(import.meta.url);
    const modulePath = join(
      dirname(require.resolve("@databricks/appkit")),
      "cache/storage/persistent.js",
    );
    const loaded = require(modulePath).PersistentStorage as
      PersistentStorageConstructor | undefined;
    if (typeof loaded !== "function") {
      logger.debug("soft persistent cache skipped (PersistentStorage missing)");
      persistentStorageCtor = undefined;
      return undefined;
    }
    persistentStorageCtor = loaded;
    return loaded;
  } catch (err) {
    logger.debug("soft persistent cache skipped (PersistentStorage unavailable)", {
      error: toError(err),
    });
    persistentStorageCtor = undefined;
    return undefined;
  }
}

/**
 * Whether an existing cache table belongs to another role.
 *
 * PostgreSQL allows granted reads/writes but reserves index DDL for the table
 * owner. Skip AppKit migrations in that case; {@link probeStorage} still proves
 * the existing table can serve the cache before it is accepted.
 */
async function tableOwnedByAnotherRole(
  storage: PersistentStorageBase,
  pool: LakebasePool,
): Promise<boolean> {
  if (!storage.schemaName || !storage.tableName) return false;
  const result = await pool.query(
    `SELECT pg_get_userbyid(c.relowner) = current_user AS owned
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
    [storage.schemaName, storage.tableName],
  );
  if (result.rows[0]?.owned !== false) return false;
  logger.warn("persistent cache migrations skipped (table owned by another role)", {
    schema: storage.schemaName,
    table: storage.tableName,
  });
  return true;
}

/** Soften `initialize()` so an ownership-only migration failure is not fatal. */
export function softenInitialize(
  storage: PersistentStorageBase,
  skipMigrations?: () => Promise<boolean>,
): void {
  const originalInitialize = storage.initialize.bind(storage);
  let softInitPromise: Promise<void> | undefined;

  storage.initialize = async () => {
    if (storage.initialized) return;
    softInitPromise ??= (async () => {
      try {
        if (!(await skipMigrations?.())) await originalInitialize();
      } catch (err) {
        if (
          !handleOwnershipMigrationError(err, {
            scope: "cache-storage",
            logger,
            event: "persistent cache migration failed",
          })
        ) {
          throw err;
        }
      }
    })();
    try {
      await softInitPromise;
      storage.initialized = true;
    } catch (err) {
      softInitPromise = undefined;
      throw err;
    }
  };
}

/** Verify the migrated cache table can serve the reads and writes AppKit needs. */
export async function probeStorage(storage: PersistentStorageBase): Promise<void> {
  const key = `dbx-tools:cache-probe:${id()}`;
  try {
    await storage.set(key, { value: key, expiry: Date.now() + 60_000 });
    const result = await storage.get(key);
    if (result?.value !== key) {
      throw new Error("persistent cache probe returned an unexpected value");
    }
  } finally {
    await storage.delete(key).catch(() => undefined);
  }
}

/**
 * Build a soft-fail Lakebase cache storage when a pool can be created and
 * AppKit's PersistentStorage can be loaded. Returns `undefined` otherwise so
 * the caller can use portable disk persistence.
 */
async function createPersistentStorage(
  cache: CacheConfig | undefined,
): Promise<CacheStorage | undefined> {
  const PersistentStorage = loadPersistentStorage();
  if (!PersistentStorage) {
    return undefined;
  }

  let pool: LakebasePool | undefined;
  try {
    const workspaceClient = (await createWorkspaceClient()).toLegacyWorkspaceClient();
    const createdPool = createLakebasePool(
      postgresConnectionOptions({ workspaceClient }),
    );
    pool = createdPool;
    const storage = new PersistentStorage(cache ?? {}, createdPool);
    softenInitialize(storage, () => tableOwnedByAnotherRole(storage, createdPool));
    if (!(await storage.healthCheck())) {
      await storage.close().catch(() => {});
      return undefined;
    }
    await storage.initialize();
    await probeStorage(storage);
    return storage;
  } catch (err) {
    logger.debug("soft persistent cache unavailable", {
      error: toError(err),
    });
    if (pool) {
      await pool.end().catch(() => {});
    }
    return undefined;
  }
}

/**
 * Create AppKit CacheStorage with bounded memory first and tracked persistence.
 * Lakebase remains AppKit's persistent owner when available; otherwise the
 * shared project-scoped portable disk level is used.
 */
export async function createAppKitCacheStorage(
  options: AppKitCacheStorageOptions = {},
): Promise<AppKitCacheStorage> {
  const nativeCache = options.cache;
  const persistent =
    options.preferLakebase === false ? undefined : await createPersistentStorage(nativeCache);
  const common: CacheOptions = {
    maxEntries: options.maxEntries ?? nativeCache?.maxSize,
    writeDelayMs: options.writeDelayMs,
  };
  const cache = persistent
    ? createCache({
        ...common,
        levels: [{ name: "appkit-persistent", store: new AppKitStorageLevel(persistent) }],
      })
    : projectCache(options.diskScope ?? "appkit", common);
  return new AppKitCacheStorage(cache, persistent);
}
