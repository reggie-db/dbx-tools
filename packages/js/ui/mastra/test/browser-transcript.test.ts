import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserTranscriptStorageKey,
  readStoredBrowserTranscript,
  storeBrowserTranscript,
} from "../src/support/browser-transcript.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("browser transcript persistence", () => {
  it("namespaces and restores a resource-scoped thread", () => {
    const storage = memoryStorage();
    const key = browserTranscriptStorageKey(
      "/api/mastra",
      "models",
      "thread/one",
      "reggie.pierce+test@databricks.com",
    );
    assert.equal(
      key,
      "dbx-mastra-transcript:/api/mastra:models:thread%2Fone:reggie.pierce%2Btest%40databricks.com",
    );
    const messages = [
      { id: "user", role: "user" as const, parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant",
        role: "assistant" as const,
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    storeBrowserTranscript(key, messages, 100, storage);
    assert.deepEqual(readStoredBrowserTranscript(key, storage), messages);
  });

  it("keeps the newest bounded messages and clears an empty transcript", () => {
    const storage = memoryStorage();
    storeBrowserTranscript(
      "thread",
      [
        { id: "one", role: "user", parts: [] },
        { id: "two", role: "assistant", parts: [] },
        { id: "three", role: "user", parts: [] },
      ],
      2,
      storage,
    );
    assert.deepEqual(
      readStoredBrowserTranscript("thread", storage).map(({ id }) => id),
      ["two", "three"],
    );
    storeBrowserTranscript("thread", [], 2, storage);
    assert.deepEqual(readStoredBrowserTranscript("thread", storage), []);
  });

  it("drops malformed storage without throwing", () => {
    const storage = memoryStorage();
    storage.setItem("thread", "not-json");
    assert.deepEqual(readStoredBrowserTranscript("thread", storage), []);
    assert.equal(storage.getItem("thread"), null);
  });
});
