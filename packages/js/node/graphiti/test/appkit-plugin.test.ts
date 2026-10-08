import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { GraphitiToolContract } from "../src/appkit/_openapi.ts";
import { graphitiToolContracts } from "../src/appkit/_openapi.ts";
import { GraphitiPlugin } from "../src/appkit/plugin.ts";

const SCOPED_TOOL_NAMES = [
  "add_memory",
  "add_triplet",
  "build_communities",
  "get_episodes",
  "get_status",
  "search_memory_facts",
  "search_nodes",
  "summarize_saga",
] as const;

function fixtureContract(name: string): GraphitiToolContract {
  return {
    path: `/tools/${name}`,
    definition: {
      name,
      description: `Upstream description for ${name}`,
      parameters: {
        type: "object",
        properties: {
          episode_body: { type: "string", description: "Memory content" },
        },
        required: ["episode_body"],
        additionalProperties: false,
      },
    },
  };
}

function fixtureOpenApi(): string {
  return JSON.stringify({
    paths: {
      "/tools/add_memory": {
        post: {
          operationId: "add_memory",
          summary: "Add Memory",
          description: "Add an episode to memory.",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/add_memoryRequest" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        add_memoryRequest: {
          type: "object",
          properties: {
            episode_body: { type: "string", description: "Memory content" },
            group_id: { anyOf: [{ type: "string" }, { type: "null" }] },
            uuid: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["episode_body"],
        },
      },
    },
  });
}

describe("GraphitiPlugin", () => {
  it("delegates runtime startup to the Node Graphiti owner without Mastra MCP", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    assert.equal(manifest.dependencies?.["@mastra/mcp"], undefined);
    assert.equal(manifest.dependencies?.["@mastra/core"], undefined);
    assert.equal(manifest.dependencies?.["@dbx-tools/cli"], undefined);
  });

  it("derives tool descriptions and schemas from OpenAPI", () => {
    const contracts = graphitiToolContracts(
      fixtureOpenApi(),
      ["add_memory"],
      new Set(["group_id", "uuid"]),
    );

    assert.equal(contracts.add_memory?.definition.description, "Add an episode to memory.");
    assert.deepEqual(contracts.add_memory?.definition.parameters, {
      type: "object",
      properties: {
        episode_body: { type: "string", description: "Memory content" },
      },
      required: ["episode_body"],
    });
  });

  it("loads tool contracts before scheduling non-blocking sidecar warmup", async () => {
    const plugin = new GraphitiPlugin({});
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    Object.assign(plugin, {
      loadToolContracts: async () => {
        events.push("contracts");
      },
      startSidecar: () => {
        events.push("sidecar");
        return pending;
      },
    });

    await plugin.setup();

    assert.deepEqual(events, ["contracts", "sidecar"]);
    release();
  });

  it("stops a runtime assigned while startup is pending", async () => {
    const plugin = new GraphitiPlugin({});
    let releaseStartup!: () => void;
    let stops = 0;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = () => {
        Object.assign(plugin, {
          runtime: {
            stop: async () => {
              stops += 1;
            },
          },
        });
        resolve();
      };
    });
    Object.assign(plugin, { startup });

    const shutdown = plugin.shutdown();
    releaseStartup();
    await shutdown;

    assert.equal(stops, 1);
  });

  it("builds toolkit entries from OpenAPI contracts", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      toolContracts: { add_memory: fixtureContract("add_memory") },
    });

    const toolkit = await plugin.toolkit({
      only: ["add_memory"],
      rename: { add_memory: "remember" },
    });

    assert.deepEqual(Object.keys(toolkit), ["remember"]);
    assert.equal(toolkit.remember?.def.description, "Upstream description for add_memory");
    assert.equal(toolkit.remember?.annotations?.effect, "write");
  });

  it("hides synchronous tools when a non-blocking counterpart exists", () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      toolContracts: {
        add_memory: fixtureContract("add_memory"),
        add_memory_sync: fixtureContract("add_memory_sync"),
        orphan_sync: fixtureContract("orphan_sync"),
      },
    });

    assert.deepEqual(
      plugin.getAgentTools().map(({ name }) => name),
      ["add_memory", "orphan_sync"],
    );
  });

  it("overrides model-supplied memory scope before direct HTTP execution", async () => {
    const plugin = new GraphitiPlugin({});
    const requests: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    Object.assign(plugin, {
      startup: Promise.resolve(),
      resolved: { listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 } },
      toolContracts: { add_memory: fixtureContract("add_memory") },
    });
    try {
      await plugin.executeAgentTool(
        "add_memory",
        {
          episode_body: "private",
          group_id: "shared",
          previous_episode_uuids: ["another-users-episode"],
          uuid: "caller-selected",
        },
        undefined,
        { resourceId: "user-a" },
      );
      await plugin.executeAgentTool("add_memory", {}, undefined, { resourceId: "user-a" });
      await plugin.executeAgentTool("add_memory", {}, undefined, { resourceId: "user-b" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.match(requests[0]?.group_id as string, /^user_/);
    assert.equal(requests[0]?.group_id, requests[1]?.group_id);
    assert.notEqual(requests[0]?.group_id, requests[2]?.group_id);
    assert.equal(requests[0]?.uuid, undefined);
    assert.equal(requests[0]?.previous_episode_uuids, undefined);
  });

  it("cancels tool execution while sidecar startup is pending", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      startup: new Promise<void>(() => {}),
      toolContracts: { add_memory: fixtureContract("add_memory") },
    });
    const controller = new AbortController();
    const pending = plugin.executeAgentTool("add_memory", {}, controller.signal, {
      resourceId: "user-a",
    });

    controller.abort(new Error("cancelled"));

    await assert.rejects(pending, /cancelled/);
  });

  it("rejects Graphiti tools without a group-scoped operation", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      startup: Promise.resolve(),
      resolved: { listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 } },
      toolContracts: { delete_episode: fixtureContract("delete_episode") },
    });

    await assert.rejects(
      plugin.executeAgentTool("delete_episode", { uuid: "other-user" }, undefined, {
        resourceId: "user-a",
      }),
      /not user-scoped/,
    );
  });

  it("rejects a sidecar port that collides with the AppKit listener", async () => {
    const previous = process.env.DATABRICKS_APP_PORT;
    process.env.DATABRICKS_APP_PORT = "48123";
    try {
      const plugin = new GraphitiPlugin({
        listen: { scheme: "tcp", host: "127.0.0.1", port: 48123 },
      });
      const startSidecar = (plugin as unknown as { startSidecar(): Promise<void> }).startSidecar;
      await assert.rejects(startSidecar.call(plugin), /must differ/);
    } finally {
      if (previous === undefined) delete process.env.DATABRICKS_APP_PORT;
      else process.env.DATABRICKS_APP_PORT = previous;
    }
  });

  it("uses the configured sidecar startup budget", async () => {
    const plugin = new GraphitiPlugin({ startupTimeoutMs: 5 });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let nowCalls = 0;
    globalThis.fetch = (async () => {
      throw new Error("not ready");
    }) as typeof fetch;
    Date.now = () => (nowCalls++ === 0 ? 100 : 106);
    Object.assign(plugin, {
      resolved: {
        startupTimeoutMs: 5,
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
    });
    try {
      const waitUntilReady = (plugin as unknown as { waitUntilReady(): Promise<void> })
        .waitUntilReady;
      await assert.rejects(waitUntilReady.call(plugin), /readiness timed out/);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });

  it("requires every configured scoped tool in the OpenAPI contract", () => {
    assert.throws(
      () => graphitiToolContracts(fixtureOpenApi(), SCOPED_TOOL_NAMES, new Set()),
      /missing tool operation: add_triplet/,
    );
  });
});
