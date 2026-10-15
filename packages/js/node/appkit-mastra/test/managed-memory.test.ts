import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";
import type { MastraDBMessage } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";

import {
  ManagedAgentMemoryClient,
  ManagedMemoryRuntime,
  resolveManagedMemoryOptions,
} from "../src/managed-memory.ts";

function fakeWorkspaceClient(available = true) {
  const requests: Array<{ path: string; method: string; payload?: unknown }> = [];
  const client = {
    apiClient: {
      request: async (request: { path: string; method: string; payload?: unknown }) => {
        requests.push(request);
        if (request.method === "GET") {
          if (!available) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
          return { name: "memory-stores/support-agent-memory" };
        }
        if (request.path.endsWith("/entries")) {
          return {
            name: "memory-stores/support-agent-memory/entries/preference",
            ...request.payload,
          };
        }
        return {
          results: [
            {
              managed_memory_entry: {
                actor_id: "user-1",
                path: "/preferences/response.md",
                content: "Prefers concise answers.",
                description: "Response preference",
              },
              score: 1,
            },
          ],
        };
      },
    },
  } as unknown as WorkspaceClient;
  return { client, requests };
}

const userMessage: MastraDBMessage = {
  id: "message-1",
  role: "user",
  createdAt: new Date("2026-10-14T00:00:00.000Z"),
  threadId: "thread-1",
  resourceId: "user-1",
  content: { format: 2, parts: [{ type: "text", text: "How should you answer?" }] },
};

describe("ManagedAgentMemoryClient", () => {
  test("searches the trusted actor partition through the Agent Memory API", async () => {
    const fake = fakeWorkspaceClient();
    const client = new ManagedAgentMemoryClient(fake.client, {
      memoryStore: "support-agent-memory",
    });

    const entries = await client.searchMemory({
      actorId: "user-1",
      query: "How should you answer?",
      topK: 5,
      pathPrefix: "/preferences",
    });

    expect(fake.requests).toMatchObject([
      {
        path: "/api/2.0/agents/memory-stores/support-agent-memory/entries:search",
        payload: {
          actor_id: "user-1",
          query: "How should you answer?",
          page_size: 5,
          path_prefix: "/preferences",
        },
      },
    ]);
    expect(entries[0]?.content).toBe("Prefers concise answers.");
  });

  test("derives the default store id from the project name", () => {
    const options = resolveManagedMemoryOptions(true);
    expect(options.memoryStore).toMatch(/^[a-z][a-z0-9-]{1,54}[a-z0-9]$/);
  });
});

describe("ManagedMemoryRuntime", () => {
  test("recalls memory through a native Mastra input processor", async () => {
    const fake = fakeWorkspaceClient();
    const runtime = new ManagedMemoryRuntime(fake.client, {
      memoryStore: "support-agent-memory",
    });
    const processor = runtime.inputProcessor()!;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "user-1");

    const result = await processor.processInput!({
      messages: [userMessage],
      systemMessages: [],
      requestContext,
      messageList: {} as never,
      state: {},
      retryCount: 0,
      abort: () => {
        throw new Error("aborted");
      },
    });

    expect(result).toMatchObject({
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("Prefers concise answers."),
        },
      ],
    });
  });

  test("adds the remember tool only when the current user can access the store", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "user-1");
    const accessible = new ManagedMemoryRuntime(fakeWorkspaceClient().client, {
      memoryStore: "support-agent-memory",
    });
    const unavailable = new ManagedMemoryRuntime(fakeWorkspaceClient(false).client, {
      memoryStore: "support-agent-memory",
    });

    const tools = await accessible.tools(requestContext);
    expect(Object.keys(tools)).toEqual(["remember"]);
    expect(await unavailable.tools(requestContext)).toEqual({});
  });
});
