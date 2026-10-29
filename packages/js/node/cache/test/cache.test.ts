import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KeyvStoreAdapter } from "cacheable";
import { Keyv } from "keyv";
import { KeyvFile } from "keyv-file";

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
  it("uses the package-owned Keyv constructor for both cache levels", async () => {
    const cache = createCache({
      levels: [{ store: new CountingStore() }],
    });

    assert.equal(cache.primary instanceof Keyv, true);
    assert.equal(cache.secondary instanceof Keyv, true);
    await closeCache(cache);
  });

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

  it("returns a stale value while coalescing one value-dependent background refresh", async () => {
    const cache = createCache();
    let calls = 0;
    let finishRefresh: ((value: boolean) => void) | undefined;
    const options = {
      ttl: "1h",
      refreshAfterWrite: (value: boolean) => (value ? 1 : "1h"),
    } as const;

    assert.equal(
      await getOrSet(
        cache,
        "enabled",
        async () => {
          calls += 1;
          return true;
        },
        options,
      ),
      true,
    );
    await delay(5);

    const refresh = async (): Promise<boolean> => {
      calls += 1;
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    };
    assert.equal(await getOrSet(cache, "enabled", refresh, options), true);
    assert.equal(await getOrSet(cache, "enabled", refresh, options), true);
    assert.equal(calls, 2);

    finishRefresh?.(false);
    await waitFor(async () => (await cache.get("enabled")) === false);
    assert.equal(
      await getOrSet(
        cache,
        "enabled",
        async () => {
          calls += 1;
          return true;
        },
        options,
      ),
      false,
    );
    assert.equal(calls, 2);
    await closeCache(cache);
  });

  it("blocks for a new load after the hard ttl expires", async () => {
    const cache = createCache();
    assert.equal(
      await getOrSet(cache, "catalog", async () => "old", {
        ttl: 5,
        refreshAfterWrite: "1h",
      }),
      "old",
    );
    await delay(10);
    assert.equal(
      await getOrSet(cache, "catalog", async () => "fresh", {
        ttl: "1h",
        refreshAfterWrite: "1h",
      }),
      "fresh",
    );
    await closeCache(cache);
  });

  it("keeps the previous value when a background refresh fails", async () => {
    const cache = createCache();
    const options = { ttl: "1h", refreshAfterWrite: 1 } as const;
    assert.equal(await getOrSet(cache, "catalog", async () => "old", options), "old");
    await delay(5);

    assert.equal(
      await getOrSet(
        cache,
        "catalog",
        async () => {
          throw new Error("offline");
        },
        options,
      ),
      "old",
    );
    await delay(5);
    assert.equal(await cache.get("catalog"), "old");
    await closeCache(cache);
  });

  it("waits for an active background refresh before closing", async () => {
    const cache = createCache();
    const options = { ttl: "1h", refreshAfterWrite: 1 } as const;
    let finishRefresh: ((value: string) => void) | undefined;
    assert.equal(await getOrSet(cache, "catalog", async () => "old", options), "old");
    await delay(5);

    assert.equal(
      await getOrSet(
        cache,
        "catalog",
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
        options,
      ),
      "old",
    );

    let closed = false;
    const closing = closeCache(cache).then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);

    finishRefresh?.("fresh");
    await closing;
    assert.equal(await cache.get("catalog"), "fresh");
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for cache refresh");
    await delay(5);
  }
}
