import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@mastra/pg";

import type { AnyMastraAgentDefinition } from "../src/agents.ts";
import type { MastraPluginConfig } from "../src/config.ts";
import {
  createMastraLakebasePool,
  createMemoryBuilder,
  withSoftStorageInit,
} from "../src/memory.ts";

type SoftStore = PostgresStore & {
  isInitialized: boolean;
};

type MemoryThreadConfig = {
  threadConfig: {
    generateTitle?: unknown;
  };
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

describe("thread title generation", () => {
  it("leaves native memory title generation disabled", async () => {
    const pool = createMastraLakebasePool({
      database: "test",
      host: "127.0.0.1",
      password: "test",
      port: 1,
      user: "test",
    });
    const config: MastraPluginConfig = {
      storage: {
        id: "title-test",
        pool,
      },
    };
    const definition: AnyMastraAgentDefinition = {
      instructions: "Test agent",
    };

    try {
      const memory = createMemoryBuilder(config).forAgent("title-test", definition);
      const generateTitle = (memory as unknown as MemoryThreadConfig).threadConfig.generateTitle;

      assert.equal(generateTitle, false);
    } finally {
      await pool.end();
    }
  });
});

describe("durable storage pool ownership", () => {
  it("keeps the plugin-owned pool live when Mastra closes a borrowed store", async () => {
    const pool = createMastraLakebasePool({
      database: "test",
      host: "127.0.0.1",
      idleTimeoutMillis: 1_234,
      password: "test",
      port: 1,
      user: "test",
    });
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    const state = pool as unknown as { ended: boolean };
    const store = new PostgresStore({
      id: "durable-test",
      pool,
      schemaName: "mastra_instance",
    });

    try {
      assert.equal(options.allowExitOnIdle, true);
      assert.equal(options.idleTimeoutMillis, 1_234);
      await store.close();
      assert.equal(state.ended, false);
    } finally {
      await pool.end();
    }
  });
});
