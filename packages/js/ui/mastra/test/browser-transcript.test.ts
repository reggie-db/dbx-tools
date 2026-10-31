import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_USAGE_PART_TYPE } from "@dbx-tools/shared-mastra";
import {
  browserTranscriptStorageKey,
  readBrowserMessageTimestamps,
  readStoredBrowserTranscript,
  storeBrowserTranscript,
  withBrowserMessageTimestamps,
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

  it("stores message timestamps and persistent model usage with the conversation", () => {
    const storage = memoryStorage();
    const createdAt = "2026-10-31T14:00:00.000Z";
    const completedAt = "2026-10-31T14:00:01.250Z";
    const assistant = withBrowserMessageTimestamps(
      {
        id: "assistant",
        role: "assistant",
        parts: [
          { type: "text", text: "Done" },
          {
            type: MODEL_USAGE_PART_TYPE,
            data: {
              runId: "run-1",
              model: "databricks-gpt-test",
              selection: "explicit",
              usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
            },
          },
        ],
      },
      { createdAt, completedAt },
    );

    storeBrowserTranscript("thread", [assistant], 100, storage);

    const restored = readStoredBrowserTranscript("thread", storage);
    assert.deepEqual(readBrowserMessageTimestamps(restored[0]!), { createdAt, completedAt });
    assert.deepEqual(restored[0]?.parts[1], assistant.parts[1]);
    assert.equal(JSON.parse(storage.getItem("thread")!).version, 2);
  });

  it("keeps transport metadata while adding timestamps", () => {
    const message = withBrowserMessageTimestamps(
      {
        id: "assistant",
        role: "assistant",
        metadata: { traceId: "trace-1" },
        parts: [],
      },
      { createdAt: "2026-10-31T14:00:00.000Z" },
    );

    assert.deepEqual(message.metadata, {
      traceId: "trace-1",
      createdAt: "2026-10-31T14:00:00.000Z",
    });
  });

  it("drops malformed storage without throwing", () => {
    const storage = memoryStorage();
    storage.setItem("thread", "not-json");
    assert.deepEqual(readStoredBrowserTranscript("thread", storage), []);
    assert.equal(storage.getItem("thread"), null);
  });
});
