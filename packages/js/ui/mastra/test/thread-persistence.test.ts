import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadStorageKey } from "../src/support/thread-persistence.ts";

describe("thread persistence", () => {
  it("keeps legacy storage unscoped when no browser identity is available", () => {
    assert.equal(
      threadStorageKey("/api/mastra", "support"),
      "dbx-mastra-thread:/api/mastra:support",
    );
  });

  it("isolates selected threads by verified browser identity", () => {
    assert.equal(
      threadStorageKey("/api/mastra", "support", "reggie.pierce+test@databricks.com"),
      "dbx-mastra-thread:/api/mastra:support:reggie.pierce%2Btest%40databricks.com",
    );
    assert.notEqual(
      threadStorageKey("/api/mastra", "support", "reggie.pierce+test@databricks.com"),
      threadStorageKey("/api/mastra", "support", "reggie.pierce@databricks.com"),
    );
  });
});
