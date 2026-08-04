import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelStorageKey,
  readStoredModel,
  storeSelectedModel,
} from "../src/support/model-selection.ts";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

describe("model selection persistence", () => {
  it("namespaces the selection by mount and agent", () => {
    assert.equal(modelStorageKey("/api/mastra", "analyst"), "dbx-mastra-model:/api/mastra:analyst");
  });

  it("restores the last-selected model", () => {
    const storage = memoryStorage();
    const key = modelStorageKey("/api/mastra", "analyst");
    storeSelectedModel(key, "databricks-claude-sonnet-4", storage);
    assert.equal(readStoredModel(key, storage), "databricks-claude-sonnet-4");
  });

  it("persists choosing the server default", () => {
    const storage = memoryStorage();
    const key = modelStorageKey("/api/mastra", "analyst");
    storeSelectedModel(key, "", storage);
    assert.equal(readStoredModel(key, storage), "");
  });

  it("falls back safely when storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readStoredModel("key", storage), "");
    assert.doesNotThrow(() => storeSelectedModel("key", "model", storage));
  });
});
