import { describe, expect, test } from "bun:test";

import type {
  GraphitiMemoryBackend,
  RecallMemoryResult,
  RememberMemoryResult,
} from "../src/_contracts.ts";
import { MemoryPlugin } from "../src/plugin.ts";

function graphitiFixture(calls: string[]): GraphitiMemoryBackend {
  return {
    running: true,
    remember: async (_actorId, input): Promise<RememberMemoryResult> => {
      calls.push("graphiti:remember");
      return { backend: "graphiti", memory: input };
    },
    recall: async (): Promise<RecallMemoryResult> => {
      calls.push("graphiti:recall");
      return { backend: "graphiti", memories: [] };
    },
    saveTurn: async () => {
      calls.push("graphiti:turn");
    },
    shutdown: async () => {
      calls.push("graphiti:shutdown");
    },
  };
}

describe("MemoryPlugin", () => {
  test("publishes only the backend-neutral tools without starting Graphiti", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    Object.assign(plugin, {
      graphitiBackend: async () => {
        calls.push("graphiti:start");
        return graphitiFixture(calls);
      },
    });

    await plugin.setup();

    expect(plugin.getAgentTools().map(({ name }) => name)).toEqual(["remember", "recall_memory"]);
    expect(Object.keys(await plugin.toolkit())).toEqual(["remember", "recall_memory"]);
    expect(calls).toEqual([]);
  });

  test("uses managed memory without loading Graphiti when it is available", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    await plugin.setup();
    Object.assign(plugin, {
      databricks: {
        available: async () => true,
        remember: async (_actorId: string, input: { path: string; content: string }) => {
          calls.push("databricks:remember");
          return { backend: "databricks", memory: input };
        },
      },
      graphitiBackend: async () => {
        throw new Error("Graphiti should remain unloaded");
      },
    });

    const result = await plugin.executeAgentTool(
      "remember",
      { path: "/preferences/response.md", content: "Concise" },
      undefined,
      { resourceId: "user-1" },
    );

    expect(result).toMatchObject({ backend: "databricks" });
    expect(calls).toEqual(["databricks:remember"]);
  });

  test("falls back to Graphiti after definitive managed-memory unavailability", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    const graphiti = graphitiFixture(calls);
    await plugin.setup();
    Object.assign(plugin, {
      databricks: {
        available: async () => false,
      },
      graphitiBackend: async () => graphiti,
    });

    const result = await plugin.executeAgentTool(
      "recall_memory",
      { query: "response preference", limit: 3 },
      undefined,
      { resourceId: "user-1" },
    );

    expect(result).toEqual({ backend: "graphiti", memories: [] });
    expect(calls).toEqual(["graphiti:recall"]);
  });

  test("falls back when cached managed availability is followed by a 403", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    const graphiti = graphitiFixture(calls);
    await plugin.setup();
    Object.assign(plugin, {
      resolved: {
        databricks: { memoryStore: "support-memory", mode: "auto" },
        graphiti: {},
        saveTurns: "auto",
      },
      databricks: {
        available: async () => true,
        remember: async () => {
          throw Object.assign(new Error("forbidden"), { statusCode: 403 });
        },
      },
      graphitiBackend: async () => graphiti,
    });

    const result = await plugin.executeAgentTool(
      "remember",
      { path: "/preferences/response.md", content: "Concise" },
      undefined,
      { resourceId: "user-1" },
    );

    expect(result).toMatchObject({ backend: "graphiti" });
    expect(calls).toEqual(["graphiti:remember"]);
  });

  test("propagates transient managed-memory failures without using Graphiti", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    await plugin.setup();
    Object.assign(plugin, {
      databricks: {
        available: async () => {
          throw Object.assign(new Error("service unavailable"), { statusCode: 503 });
        },
      },
      graphitiBackend: async () => {
        throw new Error("Graphiti should remain unloaded");
      },
    });

    await expect(
      plugin.executeAgentTool("recall_memory", { query: "response preference" }, undefined, {
        resourceId: "user-1",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  test("throws instead of falling back when Databricks is required", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    await plugin.setup();
    Object.assign(plugin, {
      resolved: {
        databricks: { memoryStore: "support-memory", mode: "required" },
        graphiti: {},
        saveTurns: "auto",
      },
      databricks: {
        available: async () => false,
      },
      graphitiBackend: async () => {
        throw new Error("Graphiti should remain unloaded");
      },
    });

    await expect(
      plugin.executeAgentTool("recall_memory", { query: "response preference" }, undefined, {
        resourceId: "user-1",
      }),
    ).rejects.toThrow(/Required Databricks managed memory is unavailable/);
  });

  test("requires Mastra when completed-turn saving is explicitly enabled", async () => {
    const plugin = new MemoryPlugin({
      databricks: false,
      graphiti: {},
      saveTurns: true,
    });

    await expect(plugin.setup()).rejects.toThrow(/requires a registered Mastra plugin/);
  });

  test("auto turn saving does not start an idle Graphiti fallback", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    const graphiti = graphitiFixture(calls);
    await plugin.setup();
    const saveTurn = (
      plugin as unknown as {
        saveTurn(turn: {
          agentId: string;
          actorId: string;
          threadId: string;
          user: string;
          assistant: string;
        }): Promise<void>;
      }
    ).saveTurn.bind(plugin);
    Object.assign(plugin, {
      graphitiBackend: async () => {
        calls.push("graphiti:start");
        return graphiti;
      },
    });

    await saveTurn({
      agentId: "support",
      actorId: "user-1",
      threadId: "thread-1",
      user: "Remember this",
      assistant: "Understood",
    });
    expect(calls).toEqual([]);

    delete (plugin as unknown as { graphitiBackend?: unknown }).graphitiBackend;
    Object.assign(plugin, { graphiti });
    await saveTurn({
      agentId: "support",
      actorId: "user-1",
      threadId: "thread-1",
      user: "Remember this",
      assistant: "Understood",
    });
    expect(calls).toEqual(["graphiti:turn"]);
  });

  test("explicit turn saving may start Graphiti", async () => {
    const plugin = new MemoryPlugin({ databricks: false, graphiti: {} });
    const calls: string[] = [];
    const graphiti = graphitiFixture(calls);
    await plugin.setup();
    const saveTurn = (
      plugin as unknown as {
        saveTurn(turn: {
          agentId: string;
          actorId: string;
          threadId: string;
          user: string;
          assistant: string;
        }): Promise<void>;
      }
    ).saveTurn.bind(plugin);
    Object.assign(plugin, {
      resolved: {
        databricks: false,
        graphiti: {},
        saveTurns: true,
      },
      graphitiBackend: async () => {
        calls.push("graphiti:start");
        return graphiti;
      },
    });

    await saveTurn({
      agentId: "support",
      actorId: "user-1",
      threadId: "thread-1",
      user: "Remember this",
      assistant: "Understood",
    });

    expect(calls).toEqual(["graphiti:start", "graphiti:turn"]);
  });
});
