/**
 * Soft-fail Lakebase cache storage for AppKit's persistent cache.
 *
 * AppKit's `PersistentStorage.initialize()` runs DDL migrations and throws on
 * any step failure. With `cache.strictPersistence: true` that throw makes
 * `CacheManager` silently disable the cache. This wraps the same storage,
 * still runs its migrations, but logs a failed step instead of throwing so a
 * usable table keeps serving.
 *
 * `PersistentStorage` is not on AppKit's public export map. The deep load is
 * lazy and best-effort: if the installed AppKit layout changes, this returns
 * `undefined` and `createApp` leaves AppKit on its default cache path.
 *
 * @module
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createLakebasePool, getWorkspaceClient, type CacheConfig } from "@databricks/appkit";
import { postgresConnectionOptions } from "@dbx-tools/postgres";
import { errorUtils, hash, log } from "@dbx-tools/shared-core";
import { LRUCache } from "lru-cache";
import { handleOwnershipMigrationError } from "./migration.ts";

const logger = log.logger("cache-storage");

type LakebasePool = ReturnType<typeof createLakebasePool>;
type CacheStorage = NonNullable<CacheConfig["storage"]>;

interface CacheEntry<T = unknown> {
  expiry: number;
  value: T;
}

/** Bounds for the process-local cache layered over persistent AppKit storage. */
export interface L1CacheStorageOptions {
  maxBytes?: number;
  maxEntries?: number;
}

/** AppKit's internal persistent storage surface. */
export type PersistentStorageBase = CacheStorage & {
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

/** Process-local LRU that avoids a persistent cache query on every warm hit. */
export class L1CacheStorage implements CacheStorage {
  private readonly entries: LRUCache<string, CacheEntry>;

  constructor(
    private readonly storage: CacheStorage,
    options: L1CacheStorageOptions = {},
  ) {
    this.entries = new LRUCache({
      max: positiveBound(options.maxEntries, 1_000, "maxEntries"),
      maxSize: positiveBound(options.maxBytes, 64 * 1024 * 1024, "maxBytes"),
      sizeCalculation: (entry, key) => retainedSize(key, entry),
    });
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const local = this.entries.get(key);
    if (local) return local as CacheEntry<T>;
    const persisted = await this.storage.get<T>(key);
    if (persisted && persisted.expiry > Date.now()) this.retain(key, persisted);
    return persisted;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await this.storage.set(key, entry);
    this.retain(key, entry);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    await this.storage.clear();
    this.entries.clear();
  }

  async has(key: string): Promise<boolean> {
    if (this.entries.has(key)) return true;
    return this.storage.has(key);
  }

  size(): Promise<number> {
    return this.storage.size();
  }

  isPersistent(): boolean {
    return this.storage.isPersistent();
  }

  healthCheck(): Promise<boolean> {
    return this.storage.healthCheck();
  }

  async close(): Promise<void> {
    this.entries.clear();
    await this.storage.close();
  }

  private retain<T>(key: string, entry: CacheEntry<T>): void {
    const ttl = entry.expiry - Date.now();
    if (ttl > 0) this.entries.set(key, entry, { ttl });
  }
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return Math.floor(resolved);
}

function retainedSize(key: string, entry: CacheEntry): number {
  try {
    return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(entry));
  } catch {
    return Number.MAX_SAFE_INTEGER;
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
      error: errorUtils.errorMessage(err),
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
  const key = `dbx-tools:cache-probe:${hash.id()}`;
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
 * AppKit can fall through to its normal cache path.
 */
export async function createSoftPersistentStorage(
  cache: CacheConfig | undefined,
): Promise<CacheStorage | undefined> {
  const PersistentStorage = loadPersistentStorage();
  if (!PersistentStorage) {
    return undefined;
  }

  let pool: LakebasePool | undefined;
  try {
    const createdPool = createLakebasePool(
      postgresConnectionOptions({ workspaceClient: getWorkspaceClient({}) }),
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
    return new L1CacheStorage(storage, {
      maxBytes: cache?.maxBytes,
      maxEntries: cache?.maxSize,
    });
  } catch (err) {
    logger.debug("soft persistent cache unavailable", {
      error: errorUtils.errorMessage(err),
    });
    if (pool) {
      await pool.end().catch(() => {});
    }
    return undefined;
  }
}
