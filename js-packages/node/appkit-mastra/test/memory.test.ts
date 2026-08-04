import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostgresStore } from "@mastra/pg";

import { withSoftStorageInit } from "../src/memory.ts";

type SoftStore = PostgresStore & {
  isInitialized: boolean;
};

function failingStore(
  id: string,
  attempts: { count: number },
  message = "must be owner of table mastra_threads",
): SoftStore {
  return {
    id,
    schema: "mastra_test",
    isInitialized: false,
    async init() {
      attempts.count += 1;
      await Promise.resolve();
      throw new Error(message);
    },
  } as unknown as SoftStore;
}

describe("soft storage initialization", () => {
  it("coalesces concurrent calls and suppresses retries after a soft failure", async () => {
    const attempts = { count: 0 };
    const store = withSoftStorageInit(failingStore("one", attempts));

    await Promise.all([store.init(), store.init()]);
    await store.init();

    assert.equal(attempts.count, 1);
    assert.equal((store as SoftStore).isInitialized, true);
  });

  it("initializes every store instance independently", async () => {
    const firstAttempts = { count: 0 };
    const secondAttempts = { count: 0 };
    const first = withSoftStorageInit(failingStore("one", firstAttempts));
    const second = withSoftStorageInit(failingStore("two", secondAttempts));

    await first.init();
    await second.init();

    assert.equal(firstAttempts.count, 1);
    assert.equal(secondAttempts.count, 1);
  });

  it("rethrows non-ownership migration failures", async () => {
    const attempts = { count: 0 };
    const store = withSoftStorageInit(
      failingStore("broken", attempts, "permission denied for schema mastra_test"),
    );

    await assert.rejects(store.init(), /permission denied/);

    assert.equal(attempts.count, 1);
    assert.equal((store as SoftStore).isInitialized, false);
  });
});
