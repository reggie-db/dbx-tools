import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createMetadataCache,
  metadataCacheDiskEnabled,
  mergePreferFreshList,
  mergePreferFreshRecord,
  resetMetadataCacheDir,
} from "../src/metadata-cache.ts";

describe("metadataCacheDiskEnabled", () => {
  it("disables disk inside a Databricks App environment", () => {
    assert.equal(
      metadataCacheDiskEnabled({
        DATABRICKS_APP_NAME: "demo",
        DATABRICKS_HOST: "https://example.cloud.databricks.com",
        DATABRICKS_APP_PORT: "8080",
      }),
      false,
    );
    assert.equal(metadataCacheDiskEnabled({}), true);
  });
});

describe("createMetadataCache", () => {
  const roots: string[] = [];

  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempCacheDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "model-metadata-cache-"));
    roots.push(root);
    return root;
  }

  it("memoizes in memory and write-throughs to cacache", async () => {
    const cacheDir = await tempCacheDir();
    let loads = 0;
    const cache = createMetadataCache({
      key: "sample",
      cacheDir,
      disk: true,
      ttlMs: 60_000,
      fallback: ["fallback"],
      load: async () => {
        loads += 1;
        return ["fresh"];
      },
      merge: mergePreferFreshList,
    });

    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.deepEqual(await cache.get(), ["fresh"]);
    assert.equal(loads, 1);

    const cold = createMetadataCache({
      key: "sample",
      cacheDir,
      disk: true,
      ttlMs: 60_000,
      fallback: ["fallback"],
      load: async () => {
        loads += 1;
        return ["should-not-run"];
      },
      merge: mergePreferFreshList,
    });
    assert.deepEqual(await cold.get(), ["fresh"]);
    assert.equal(loads, 1);
  });

  it("skips cacache when disk is disabled", async () => {
    const cacheDir = await tempCacheDir();
    const cache = createMetadataCache({
      key: "learned",
      cacheDir,
      disk: false,
      ttlMs: 60_000,
      fallback: {},
      merge: mergePreferFreshRecord,
    });

    await cache.update((current) => ({ ...current, grok: ["low", "high"] }));
    assert.deepEqual(await cache.peek(), { grok: ["low", "high"] });

    const cold = createMetadataCache({
      key: "learned",
      cacheDir,
      disk: false,
      ttlMs: 60_000,
      fallback: {},
      merge: mergePreferFreshRecord,
    });
    assert.equal(await cold.peek(), undefined);
  });

  it("falls back to last good / hard-coded when load fails", async () => {
    const cacheDir = await tempCacheDir();
    await resetMetadataCacheDir(cacheDir);
    const cache = createMetadataCache({
      key: "broken",
      cacheDir,
      disk: true,
      ttlMs: 1,
      fallback: ["fallback"],
      load: async () => {
        throw new Error("network down");
      },
      merge: mergePreferFreshList,
    });
    assert.deepEqual(await cache.get(), ["fallback"]);
  });
});
