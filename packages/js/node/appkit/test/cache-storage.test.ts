import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCache } from "@dbx-tools/cache/cache";
import {
  AppKitCacheStorage,
  loadPersistentStorage,
  probeStorage,
  softenInitialize,
  type PersistentStorageBase,
} from "../src/cache-storage.ts";

function storageWithInit(
  initialize: () => Promise<void>,
  overrides: Partial<PersistentStorageBase> = {},
): PersistentStorageBase {
  const values = new Map<string, unknown>();
  return {
    initialized: false,
    initialize,
    healthCheck: async () => true,
    close: async () => {},
    get: async (key: string) => values.get(key) as never,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    clear: async () => {},
    has: async (key: string) => values.has(key),
    size: async () => values.size,
    isPersistent: () => true,
    ...overrides,
  } as PersistentStorageBase;
}

describe("soft persistent cache initialization", () => {
  it("resolves the AppKit 0.81 private persistent storage compatibility seam", () => {
    assert.equal(typeof loadPersistentStorage(), "function");
  });

  it("skips migrations when a preflight detects a different table owner", async () => {
    let attempts = 0;
    const storage = storageWithInit(async () => {
      attempts += 1;
    });
    softenInitialize(storage, async () => true);

    await storage.initialize();

    assert.equal(attempts, 0);
    assert.equal(storage.initialized, true);
  });

  it("coalesces and softens ownership-only migration failures", async () => {
    let attempts = 0;
    const storage = storageWithInit(async () => {
      attempts += 1;
      throw new Error("must be owner of table appkit_cache_entries");
    });
    softenInitialize(storage);

    await Promise.all([storage.initialize(), storage.initialize()]);

    assert.equal(attempts, 1);
    assert.equal(storage.initialized, true);
  });

  it("rethrows other migration failures", async () => {
    const storage = storageWithInit(async () => {
      throw new Error("permission denied for schema appkit");
    });
    softenInitialize(storage);

    await assert.rejects(storage.initialize(), /permission denied/);
    assert.equal(storage.initialized, false);
  });

  it("rejects a storage backend whose cache table is unusable", async () => {
    const storage = storageWithInit(async () => {}, {
      get: async () => null,
    });

    await assert.rejects(probeStorage(storage), /unexpected value/);
  });
});

describe("memory-first AppKit cache storage", () => {
  it("serves warm values without another persistent read", async () => {
    let reads = 0;
    const storage = storageWithInit(async () => {});
    const originalGet = storage.get.bind(storage);
    storage.get = async (key) => {
      reads += 1;
      return originalGet(key);
    };
    const l1 = new AppKitCacheStorage(
      createCache({ levels: [{ store: storageLevel(storage) }], maxEntries: 1 }),
      storage,
    );
    const future = Date.now() + 60_000;
    await l1.set("key", { value: "value", expiry: future });
    await l1.set("evict", { value: "other", expiry: future });
    await l1.flush();

    assert.equal((await l1.get<string>("key"))?.value, "value");
    assert.equal((await l1.get<string>("key"))?.value, "value");
    assert.equal(reads, 1);
  });

  it("keeps writes and invalidations coherent across layers", async () => {
    const storage = storageWithInit(async () => {});
    const l1 = new AppKitCacheStorage(
      createCache({ levels: [{ store: storageLevel(storage) }], maxEntries: 1 }),
      storage,
    );
    const future = Date.now() + 60_000;

    await l1.set("first", { value: 1, expiry: future });
    await l1.set("second", { value: 2, expiry: future });
    await l1.flush();
    await l1.delete("first");
    assert.equal(await l1.get("first"), null);
    assert.equal((await l1.get<number>("second"))?.value, 2);

    await l1.delete("second");
    assert.equal(await l1.get("second"), null);
  });

  it("forwards AppKit's persistent cleanup compatibility hook", async () => {
    let cleanups = 0;
    const storage = storageWithInit(async () => {}, {
      async cleanupExpired() {
        cleanups += 1;
        return 3;
      },
    });
    const l1 = new AppKitCacheStorage(createCache(), storage);

    assert.equal(await l1.cleanupExpired(), 3);
    assert.equal(cleanups, 1);
    assert.equal(
      await new AppKitCacheStorage(
        createCache(),
        storageWithInit(async () => {}),
      ).cleanupExpired(),
      0,
    );
  });
});

function storageLevel(storage: PersistentStorageBase) {
  return {
    opts: {},
    on() {
      return this;
    },
    async get<T>(key: string): Promise<T | undefined> {
      return (await storage.get<T>(key))?.value;
    },
    async set(key: string, value: unknown, ttl?: number): Promise<void> {
      await storage.set(key, { value, expiry: Date.now() + (ttl ?? 60_000) });
    },
    async delete(key: string): Promise<boolean> {
      await storage.delete(key);
      return true;
    },
    clear: () => storage.clear(),
    has: (key: string) => storage.has(key),
  };
}
