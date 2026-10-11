import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeRunStorageKey,
  readStoredActiveRuns,
  removeStoredActiveRun,
  storeActiveRun,
} from "../src/support/active-runs.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("active background run persistence", () => {
  it("namespaces, restores, and clears reload recovery metadata", () => {
    const storage = memoryStorage();
    const key = activeRunStorageKey("/api/mastra", "support");
    assert.equal(key, "dbx-mastra-active-runs:/api/mastra:support");
    storeActiveRun(
      key,
      {
        threadId: "thread",
        runId: "run",
        assistantId: "assistant",
        userMessage: { id: "user", role: "user", parts: [{ type: "text", text: "hello" }] },
        startedAt: 1_000,
      },
      storage,
    );
    assert.deepEqual(
      readStoredActiveRuns(key, storage, 2_000).map((run) => run.runId),
      ["run"],
    );
    removeStoredActiveRun(key, "run", storage);
    assert.deepEqual(readStoredActiveRuns(key, storage, 2_000), []);
  });

  it("drops stale or malformed recovery metadata without throwing", () => {
    const storage = memoryStorage();
    const key = "runs";
    storage.setItem(key, "not-json");
    assert.deepEqual(readStoredActiveRuns(key, storage), []);
    storeActiveRun(
      key,
      {
        threadId: "thread",
        runId: "stale",
        assistantId: "assistant",
        userMessage: { id: "user", role: "user", parts: [] },
        startedAt: 0,
      },
      storage,
    );
    assert.deepEqual(readStoredActiveRuns(key, storage, 24 * 60 * 60 * 1_000 + 1), []);
  });
});
