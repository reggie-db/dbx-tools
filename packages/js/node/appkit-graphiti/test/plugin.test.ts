import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { OpenApiTool } from "@dbx-tools/appkit-mastra/openapi-tool";
import { GraphitiPlugin } from "../src/plugin.ts";

function fixtureSchema(name: string, urlName = name): OpenApiTool {
  return {
    id: name,
    description: `Upstream description for ${name}`,
    url: `http://127.0.0.1:4101/tools/${urlName}`,
    method: "POST",
    inputSchema: {
      type: "object",
      properties: {
        episode_body: { type: "string", description: "Memory content" },
        group_id: { anyOf: [{ type: "string" }, { type: "null" }] },
        uuid: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["episode_body"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  };
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

  it("maps OpenAPI tool schemas to scoped AppKit definitions", () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      toolSchemas: [
        fixtureSchema("add_memory_sync"),
        fixtureSchema("add_triplet"),
        fixtureSchema("search_memory_facts"),
        fixtureSchema("search_nodes"),
        fixtureSchema("get_episodes"),
        fixtureSchema("summarize_saga"),
        fixtureSchema("build_communities"),
        fixtureSchema("get_status"),
      ],
    });
    assert.deepEqual(plugin.getAgentTools()[0]?.parameters, {
      type: "object",
      additionalProperties: false,
      properties: {
        episode_body: { type: "string", description: "Memory content" },
      },
      required: ["episode_body"],
    });
  });

  it("waits for sidecar setup", async () => {
    const plugin = new GraphitiPlugin({});
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    Object.assign(plugin, {
      startSidecar: () => {
        events.push("sidecar");
        return pending;
      },
    });

    const setup = plugin.setup();
    await Promise.resolve();
    assert.deepEqual(events, ["sidecar"]);
    release();
    await setup;
  });

  it("SIGTERMs the AppKit process when the sidecar healthcheck budget is exhausted", async () => {
    const plugin = new GraphitiPlugin({});
    const signals: NodeJS.Signals[] = [];
    const kill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === process.pid) {
        signals.push(typeof signal === "string" ? signal : "SIGTERM");
        return true;
      }
      return kill(pid, signal);
    }) as typeof process.kill;
    Object.assign(plugin, {
      sidecar: {
        shutdown: async () => undefined,
      },
    });
    try {
      await (
        plugin as unknown as { failAppkit(): Promise<void> }
      ).failAppkit();
    } finally {
      process.kill = kill;
    }

    assert.deepEqual(signals, ["SIGTERM"]);
  });

  it("stops the assigned sidecar", async () => {
    const plugin = new GraphitiPlugin({});
    let stops = 0;
    Object.assign(plugin, {
      sidecar: {
        shutdown: async () => {
          stops += 1;
        },
      },
    });

    await plugin.shutdown();

    assert.equal(stops, 1);
  });

  it("keeps shutdown health-check aborts rejected for active callers", async () => {
    const plugin = new GraphitiPlugin({});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })) as typeof fetch;
    Object.assign(plugin, {
      resolved: {
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
    });
    try {
      (
        plugin as unknown as {
          watchSidecarHealth(timeoutMs: number): void;
        }
      ).watchSidecarHealth(30_000);
      const ready = (
        plugin as unknown as {
          ready: Promise<void>;
        }
      ).ready;
      const rejected = assert.rejects(ready, { name: "AbortError" });

      await plugin.shutdown();
      await rejected;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builds toolkit entries from OpenAPI contracts", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      toolSchemas: [
        fixtureSchema("add_memory_sync"),
        fixtureSchema("add_triplet"),
        fixtureSchema("search_memory_facts"),
        fixtureSchema("search_nodes"),
        fixtureSchema("get_episodes"),
        fixtureSchema("summarize_saga"),
        fixtureSchema("build_communities"),
        fixtureSchema("get_status"),
      ],
    });

    const toolkit = await plugin.toolkit({
      only: ["add_memory"],
      rename: { add_memory: "remember" },
    });

    assert.deepEqual(Object.keys(toolkit), ["remember"]);
    assert.match(toolkit.remember?.def.description ?? "", /waits for extraction/);
    assert.equal(toolkit.remember?.annotations?.effect, "write");
  });

  it("maps the model-facing add_memory tool to the durable synchronous operation", () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      toolSchemas: [
        fixtureSchema("add_memory"),
        fixtureSchema("add_memory_sync"),
        fixtureSchema("add_triplet"),
        fixtureSchema("search_memory_facts"),
        fixtureSchema("search_nodes"),
        fixtureSchema("get_episodes"),
        fixtureSchema("summarize_saga"),
        fixtureSchema("build_communities"),
        fixtureSchema("get_status"),
      ],
    });

    assert.deepEqual(
      plugin.getAgentTools().map(({ name }) => name),
      [
        "add_memory",
        "add_triplet",
        "search_memory_facts",
        "search_nodes",
        "get_episodes",
        "summarize_saga",
        "build_communities",
        "get_status",
      ],
    );
  });

  it("awaits sidecar healthcheck before executing a tool", async () => {
    const plugin = new GraphitiPlugin({});
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    Object.assign(plugin, {
      sidecar: { running: true },
      resolved: {
        bearer: "test-bearer",
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
      toolSchemas: [fixtureSchema("add_memory_sync")],
      ready,
    });
    try {
      const execution = plugin.executeAgentTool(
        "add_memory",
        { episode_body: "private" },
        undefined,
        { resourceId: "user-a" },
      );
      await Promise.resolve();
      assert.equal(fetched, false);
      release();
      await execution;
      assert.equal(fetched, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("overrides model-supplied memory scope before direct HTTP execution", async () => {
    const plugin = new GraphitiPlugin({});
    const requests: Record<string, unknown>[] = [];
    const authorizations: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    Object.assign(plugin, {
      sidecar: { running: true },
      resolved: {
        bearer: "test-bearer",
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
      toolSchemas: [fixtureSchema("add_memory_sync")],
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
    assert.deepEqual(authorizations, ["Bearer test-bearer", "Bearer test-bearer", "Bearer test-bearer"]);
  });

  it("executes add_memory through the synchronous sidecar route", async () => {
    const plugin = new GraphitiPlugin({});
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ message: "persisted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    Object.assign(plugin, {
      sidecar: { running: true },
      resolved: {
        bearer: "test-bearer",
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
      toolSchemas: [fixtureSchema("add_memory_sync", "add_memory_sync")],
    });
    try {
      await plugin.executeAgentTool(
        "add_memory",
        { name: "Preference", episode_body: "Prefers concise answers" },
        undefined,
        { resourceId: "user-a" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(urls, ["http://127.0.0.1:4101/tools/add_memory_sync"]);
  });

  it("rejects Graphiti tools without a group-scoped operation", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      sidecar: { running: true },
      resolved: {
        bearer: "test-bearer",
        listen: { scheme: "tcp", host: "127.0.0.1", port: 4101 },
      },
      toolSchemas: [fixtureSchema("delete_episode")],
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

});
