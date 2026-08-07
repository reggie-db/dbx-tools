import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  probeStorage,
  softenInitialize,
  type PersistentStorageBase,
} from "../src/_cache-storage.ts";

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
    ...overrides,
  } as PersistentStorageBase;
}

describe("soft persistent cache initialization", () => {
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
      get: async () => undefined,
    });

    await assert.rejects(probeStorage(storage), /unexpected value/);
  });
});
