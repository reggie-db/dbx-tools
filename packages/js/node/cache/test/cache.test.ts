import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KeyvStoreAdapter } from "cacheable";
import KeyvFile from "keyv-file";

import {
  cachePath,
  closeCache,
  createCache,
  flushCache,
  getOrSet,
  projectCache,
} from "../src/cache.ts";

class CountingStore extends EventEmitter implements KeyvStoreAdapter {
  readonly opts = {};
  readonly values = new Map<string, unknown>();
  sets = 0;

  async get<Value>(key: string): Promise<Value | undefined> {
    return this.values.get(key) as Value | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.sets += 1;
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

describe("createCache", () => {
  it("coalesces write-behind mutations and drains them", async () => {
    const store = new CountingStore();
    const cache = createCache({
      levels: [{ name: "counting", store }],
      writeDelayMs: 10_000,
    });

    await cache.set("key", "first");
    await cache.set("key", "second");
    assert.equal(store.sets, 0);
    assert.equal(await cache.get("key"), "second");

    await flushCache(cache);
    assert.equal(store.sets, 1);
    await closeCache(cache);
  });

  it("recovers falsy values from a persistent secondary", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-cache-falsy-"));
    const filename = join(root, "cache.json");
    try {
      const first = createCache({
        levels: [{ store: new KeyvFile({ filename, writeDelay: 0 }) }],
        maxEntries: 1,
        writeDelayMs: 0,
      });
      await first.set("false", false);
      await first.set("evict", true);
      await closeCache(first);

      const second = createCache({
        levels: [{ store: new KeyvFile({ filename, writeDelay: 0 }) }],
        maxEntries: 1,
        writeDelayMs: 0,
      });
      assert.equal(await second.get("false"), false);
      await closeCache(second);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns a cached successful value on loader error only when requested", async () => {
    const cache = createCache();
    assert.equal(
      await getOrSet(cache, "enabled", async () => "fresh", { returnCachedOnError: true }),
      "fresh",
    );
    await cache.delete("enabled");
    assert.equal(
      await getOrSet(
        cache,
        "enabled",
        async () => {
          throw new Error("offline");
        },
        { returnCachedOnError: true },
      ),
      "fresh",
    );
    assert.equal(
      await getOrSet(cache, "disabled", async () => {
        throw new Error("offline");
      }),
      undefined,
    );
    await closeCache(cache);
  });
});

describe("projectCache", () => {
  const roots: string[] = [];

  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  });

  it("uses a process registry and project-scoped disk path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-project-cache-"));
    roots.push(root);
    const options = { cacheDir: root, projectName: "@dbx-tools/example" };
    const first = projectCache("models", options);
    const second = projectCache("models", options);

    assert.equal(first, second);
    assert.equal(
      cachePath("models", options),
      join(root, "cache", "%40dbx-tools%2Fexample", "models.json"),
    );
    await closeCache(first);
  });
});
