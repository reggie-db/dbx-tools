import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";

import { ManagedAgentMemoryClient } from "../src/databricks/client.ts";

function fakeWorkspaceClient(available = true) {
  const requests: Array<{
    path: string;
    method: string;
    payload?: unknown;
    query?: unknown;
  }> = [];
  const client = {
    apiClient: {
      request: async (request: {
        path: string;
        method: string;
        payload?: unknown;
        query?: unknown;
      }) => {
        requests.push(request);
        if (request.method === "GET") {
          if (!available) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
          if (request.path.endsWith("/entries")) return { managed_memory_entries: [] };
          return { name: "memory-stores/support-memory" };
        }
        if (request.path.endsWith("/entries")) {
          return {
            name: "memory-stores/support-memory/entries/preference",
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

describe("ManagedAgentMemoryClient", () => {
  test("distinguishes inaccessible stores from transient request failures", async () => {
    const unavailable = new ManagedAgentMemoryClient(fakeWorkspaceClient(false).client, {
      memoryStore: "support-memory",
    });
    expect(await unavailable.available()).toBe(false);

    const client = {
      apiClient: {
        request: async () => {
          throw Object.assign(new Error("service unavailable"), { statusCode: 503 });
        },
      },
    } as unknown as WorkspaceClient;
    const transient = new ManagedAgentMemoryClient(client, { memoryStore: "support-memory" });
    await expect(transient.available()).rejects.toMatchObject({ statusCode: 503 });
  });

  test("searches the trusted actor partition", async () => {
    const fake = fakeWorkspaceClient();
    const client = new ManagedAgentMemoryClient(fake.client, {
      memoryStore: "support-memory",
    });

    const entries = await client.searchMemory({
      actorId: "user-1",
      query: "How should you answer?",
      limit: 5,
    });

    expect(fake.requests).toContainEqual(
      expect.objectContaining({
        path: "/api/2.0/agents/memory-stores/support-memory/entries:search",
        payload: {
          actor_id: "user-1",
          query: "How should you answer?",
          page_size: 5,
        },
      }),
    );
    expect(entries[0]).toMatchObject({
      entry: { content: "Prefers concise answers." },
      score: 1,
    });
  });

  test("creates a path when no existing entry is present", async () => {
    const fake = fakeWorkspaceClient();
    const client = new ManagedAgentMemoryClient(fake.client, {
      memoryStore: "support-memory",
    });

    const saved = await client.saveMemory({
      actorId: "user-1",
      path: "/preferences/response.md",
      content: "Prefers concise answers.",
    });

    expect(saved).toMatchObject({
      actor_id: "user-1",
      path: "/preferences/response.md",
      content: "Prefers concise answers.",
    });
  });
});
