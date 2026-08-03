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
import { error, log } from "@dbx-tools/shared-core";

const logger = log.logger("cache-storage");

/** Whether `LOG_LEVEL` is currently at or below debug. */
function isDebugEnabled(): boolean {
  return log.isLevelEnabled("debug");
}

type LakebasePool = ReturnType<typeof createLakebasePool>;
type CacheStorage = NonNullable<CacheConfig["storage"]>;

/** AppKit's internal persistent storage surface. */
type PersistentStorageBase = CacheStorage & {
  initialize(): Promise<void>;
  initialized: boolean;
};

type PersistentStorageConstructor = new (
  config: CacheConfig,
  pool: LakebasePool,
) => PersistentStorageBase;

let persistentStorageCtor: PersistentStorageConstructor | undefined | null = null;

/**
 * Lazily resolve AppKit's internal `PersistentStorage` constructor. `null`
 * means the lookup already failed; `undefined` means not attempted yet.
 */
function loadPersistentStorage(): PersistentStorageConstructor | undefined {
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
      error: error.errorMessage(err),
    });
    persistentStorageCtor = undefined;
    return undefined;
  }
}

/** Soften `initialize()` so a migration failure is logged, not thrown. */
function softenInitialize(storage: PersistentStorageBase): void {
  const originalInitialize = storage.initialize.bind(storage);
  storage.initialize = async () => {
    try {
      await originalInitialize();
    } catch (err) {
      if (isDebugEnabled()) {
        logger.error("persistent cache migration failed", err);
      } else {
        logger.warn("persistent cache migration failed", {
          error: error.errorMessage(err),
        });
      }
      storage.initialized = true;
    }
  };
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
    pool = createLakebasePool({ workspaceClient: getWorkspaceClient({}) });
    const storage = new PersistentStorage(cache ?? {}, pool);
    softenInitialize(storage);
    if (!(await storage.healthCheck())) {
      await storage.close().catch(() => {});
      return undefined;
    }
    await storage.initialize();
    return storage;
  } catch (err) {
    logger.debug("soft persistent cache unavailable", {
      error: error.errorMessage(err),
    });
    if (pool) {
      await pool.end().catch(() => {});
    }
    return undefined;
  }
}
