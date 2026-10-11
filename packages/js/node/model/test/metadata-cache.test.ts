import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeCache, createCache, projectCache } from "@dbx-tools/cache/cache";

import {
  createMetadataCache,
  mergePreferFreshList,
  mergePreferFreshRecord,
} from "../src/metadata-cache.ts";

describe("createMetadataCache", () => {
  it("memoizes through the shared metadata store", async () => {
    const store = createCache({ useClone: false });
    let loads = 0;
    const cache = createMetadataCache(
      {
        key: "sample",
        ttlMs: 60_000,
        fallback: ["fallback"],
        load: async () => {
          loads += 1;
          return ["fresh"];
        },
        merge: mergePreferFreshList,
      },
      store,
    );

    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.equal(loads, 1);

    const cold = createMetadataCache(
      {
        key: "sample",
        ttlMs: 60_000,
        fallback: ["fallback"],
        load: async () => {
          loads += 1;
          return ["should-not-run"];
        },
        merge: mergePreferFreshList,
      },
      store,
    );
    assert.deepEqual(await cold.get(), ["fresh"]);
    assert.equal(loads, 1);
  });

  it("shares memory-only values across handles", async () => {
    const store = createCache({ useClone: false });
    const cache = createMetadataCache(
      {
        key: "learned",
        ttlMs: 60_000,
        fallback: {},
        merge: mergePreferFreshRecord,
      },
      store,
    );

    await cache.update((current) => ({ ...current, grok: ["low", "high"] }));
    assert.deepEqual(await cache.peek(), { grok: ["low", "high"] });

    const cold = createMetadataCache(
      {
        key: "learned",
        ttlMs: 60_000,
        fallback: {},
        merge: mergePreferFreshRecord,
      },
      store,
    );
    assert.deepEqual(await cold.peek(), { grok: ["low", "high"] });
  });

  it("falls back to last good / hard-coded when load fails", async () => {
    const store = createCache({ useClone: false });
    const cache = createMetadataCache(
      {
        key: "broken",
        ttlMs: 1,
        fallback: ["fallback"],
        load: async () => {
          throw new Error("network down");
        },
        merge: mergePreferFreshList,
      },
      store,
    );
    assert.deepEqual(await cache.get(), ["fallback"]);
  });

  it("retries a failed refresh while serving the previous value", async () => {
    const store = createCache({ useClone: false });
    let loads = 0;
    let fail = false;
    const cache = createMetadataCache(
      {
        key: "stale",
        ttlMs: 1,
        fallback: ["fallback"],
        load: async () => {
          loads += 1;
          if (fail) throw new Error("offline");
          return ["fresh"];
        },
        merge: mergePreferFreshList,
      },
      store,
    );

    assert.deepEqual(await cache.get(), ["fresh"]);
    await Bun.sleep(5);
    fail = true;
    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.equal(loads, 3);
  });

  it("loads the known-good value from the disk tier after restart", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "model-metadata-cache-"));
    const storeOptions = {
      cacheDir,
      diskWriteDelayMs: 0,
      projectName: "metadata-test",
      useClone: false,
      writeDelayMs: 0,
    };
    try {
      const firstStore = projectCache("known-good", storeOptions);
      const first = createMetadataCache(
        {
          key: "known-good",
          ttlMs: 1,
          fallback: ["fallback"],
          load: async () => ["fresh"],
          merge: mergePreferFreshList,
        },
        firstStore,
      );
      assert.deepEqual(await first.get(), ["fresh"]);
      await closeCache(firstStore);

      await Bun.sleep(5);
      const secondStore = projectCache("known-good", storeOptions);
      const second = createMetadataCache(
        {
          key: "known-good",
          ttlMs: 1,
          fallback: ["fallback"],
          load: async () => {
            throw new Error("offline");
          },
          merge: mergePreferFreshList,
        },
        secondStore,
      );
      assert.deepEqual(await second.get(), ["fresh"]);
      await closeCache(secondStore);
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });
});
