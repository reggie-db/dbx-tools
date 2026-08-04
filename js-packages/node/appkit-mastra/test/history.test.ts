import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";

import { clearHistory } from "../src/history.ts";

function agentWithMemory(memory: object): Agent {
  return {
    id: "support",
    getMemory: async () => memory,
  } as unknown as Agent;
}

describe("history ownership", () => {
  it("does not clear a thread owned by another resource", async () => {
    let deleted = false;
    const agent = agentWithMemory({
      getThreadById: async () => ({ id: "thread-1", resourceId: "other-user" }),
      deleteThread: async () => {
        deleted = true;
      },
    });

    const result = await clearHistory({
      agent,
      threadId: "thread-1",
      resourceId: "current-user",
    });

    assert.deepEqual(result, { cleared: 0 });
    assert.equal(deleted, false);
  });

  it("counts and clears a thread owned by the caller", async () => {
    let deletedThread: string | undefined;
    const agent = agentWithMemory({
      getThreadById: async () => ({ id: "thread-1", resourceId: "current-user" }),
      recall: async () => ({ messages: [], total: 4, hasMore: false }),
      deleteThread: async (threadId: string) => {
        deletedThread = threadId;
      },
    });

    const result = await clearHistory({
      agent,
      threadId: "thread-1",
      resourceId: "current-user",
    });

    assert.deepEqual(result, { cleared: 4 });
    assert.equal(deletedThread, "thread-1");
  });
});
