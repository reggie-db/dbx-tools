import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createMockRouter } from "@databricks/appkit/testing";
import { GRAPHITI_PYTHON_VERSION } from "../src/_python-runtime.ts";
import { GraphitiPlugin, ensureGraphitiModelGateway, ensureGraphitiPython } from "../src/plugin.ts";

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

function fixtureTool(name: string) {
  const parameters = {
    type: "object",
    properties: {
      episode_body: { type: "string", description: "Memory content" },
    },
    required: ["episode_body"],
    additionalProperties: false,
  } as const;
  return {
    description: `Upstream description for ${name}`,
    inputSchema: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { episode_body?: unknown }).episode_body === "string"
            ? { value }
            : { issues: [{ message: "episode_body is required" }] },
        jsonSchema: {
          input: () => parameters,
          output: () => parameters,
        },
      },
    },
    execute: async (args: unknown) => args,
  };
}

describe("GraphitiPlugin routes", () => {
  it("depends on the foreground model gateway instead of Rust or the umbrella CLI", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    assert.equal(manifest.dependencies?.["@dbx-tools/cli-model-gateway"], "workspace:^");
    assert.equal(manifest.dependencies?.["@dbx-tools/rust-binary"], undefined);
    assert.equal(manifest.dependencies?.["@dbx-tools/cli"], undefined);
  });

  it("does not block AppKit setup while sidecars warm", async () => {
    const plugin = new GraphitiPlugin({});
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(plugin, { startSidecars: () => pending });

    await plugin.setup();
    release();
  });

  it("installs the matching Python package when its version is absent or stale", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await ensureGraphitiPython("python3", async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) throw new Error("missing module");
    });

    assert.equal(calls[0]?.file, "python3");
    assert.equal(calls[0]?.args[0], "-c");
    assert.match(calls[0]?.args[1] ?? "", /importlib\.metadata\.version/);
    assert.deepEqual(calls[1], { file: "python3", args: ["-m", "pip", "--version"] });
    assert.ok(calls[2]?.args.includes("--upgrade"));
    assert.equal(calls[2]?.args.at(-1), `dbx-tools-graphiti==${GRAPHITI_PYTHON_VERSION}`);
  });

  it("bootstraps pip when the App Python omits it", async () => {
    const calls: string[][] = [];
    await ensureGraphitiPython("python3", async (_file, args) => {
      calls.push(args);
      if (calls.length < 3) throw new Error("missing");
    });

    assert.match(calls[2]?.[1] ?? "", /urllib\.request/);
    assert.equal(calls[3]?.at(-1), `dbx-tools-graphiti==${GRAPHITI_PYTHON_VERSION}`);
  });

  it("resolves the foreground TypeScript model gateway by absolute path", () => {
    const command = ensureGraphitiModelGateway(
      () => "/cache/dbx-model-gateway/bin/dbx-model-gateway.ts",
    );

    assert.match(command, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(command, /dbx-model-gateway\.ts/);
  });

  it("registers the MCP transport on the AppKit server", () => {
    const { router, handlers } = createMockRouter();
    const plugin = new GraphitiPlugin({});

    plugin.injectRoutes(router);

    assert.deepEqual(Object.keys(handlers), ["GET:/mcp", "POST:/mcp", "DELETE:/mcp"]);
    assert.deepEqual(plugin.getEndpoints(), {
      getMcp: "/api/graphiti/mcp",
      postMcp: "/api/graphiti/mcp",
      deleteMcp: "/api/graphiti/mcp",
    });
    assert.deepEqual([...plugin.getSkipBodyParsingPaths()], []);
  });

  it("overrides model-supplied memory scope with the Mastra resource id", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, {
      mcpTools: {
        add_memory: {
          execute: async (args: unknown) => args,
        },
      },
    });

    const first = (await plugin.executeAgentTool(
      "add_memory",
      {
        episode_body: "private",
        group_id: "shared",
        previous_episode_uuids: ["another-users-episode"],
        uuid: "caller-selected",
      },
      undefined,
      { resourceId: "user-a" },
    )) as Record<string, unknown>;
    const second = (await plugin.executeAgentTool("add_memory", {}, undefined, {
      resourceId: "user-a",
    })) as Record<string, unknown>;
    const other = (await plugin.executeAgentTool("add_memory", {}, undefined, {
      resourceId: "user-b",
    })) as Record<string, unknown>;

    assert.match(first.group_id as string, /^user_/);
    assert.equal(first.group_id, second.group_id);
    assert.notEqual(first.group_id, other.group_id);
    assert.equal(first.uuid, undefined);
    assert.equal(first.previous_episode_uuids, undefined);
  });

  it("builds toolkit entries from discovered descriptions and schemas", async () => {
    const plugin = new GraphitiPlugin({});
    const tool = fixtureTool("add_memory");
    Object.assign(plugin, { mcpTools: { add_memory: tool } });

    const toolkit = await plugin.toolkit({
      only: ["add_memory"],
      rename: { add_memory: "remember" },
    });

    assert.deepEqual(Object.keys(toolkit), ["remember"]);
    assert.equal(toolkit.remember?.def.description, "Upstream description for add_memory");
    assert.deepEqual(toolkit.remember?.def.parameters, {
      type: "object",
      properties: {
        episode_body: { type: "string", description: "Memory content" },
      },
      required: ["episode_body"],
      additionalProperties: false,
    });
    const validation = await tool.inputSchema["~standard"].validate({});
    assert.deepEqual(validation, { issues: [{ message: "episode_body is required" }] });
  });

  it("waits for sidecar startup before discovering MCP tools", async () => {
    const plugin = new GraphitiPlugin({});
    let release!: () => void;
    const startup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discovered = Object.fromEntries(
      SCOPED_TOOL_NAMES.map((name) => [`graphiti_${name}`, fixtureTool(name)]),
    );
    Object.assign(plugin, {
      startup,
      resolved: { graphitiPort: 4101, proxyPort: 4102 },
      mcp: { listTools: async () => discovered },
    });
    let ready = false;
    const pending = plugin.toolkit().then((toolkit) => {
      ready = true;
      return toolkit;
    });

    await Promise.resolve();
    assert.equal(ready, false);
    release();
    const toolkit = await pending;
    assert.equal(Object.keys(toolkit).length, SCOPED_TOOL_NAMES.length);
  });

  it("propagates sidecar startup failure to toolkit registration", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, { startup: Promise.reject(new Error("sidecar unavailable")) });

    await assert.rejects(plugin.toolkit(), /sidecar unavailable/);
  });

  it("cancels tool execution while sidecar discovery is pending", async () => {
    const plugin = new GraphitiPlugin({});
    Object.assign(plugin, { startup: new Promise<void>(() => {}) });
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
      mcpTools: {
        delete_episode: {
          execute: async (args: unknown) => args,
        },
      },
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
    const kill = process.kill;
    const signals: NodeJS.Signals[] = [];
    process.env.DATABRICKS_APP_PORT = "48123";
    process.kill = ((_pid: number, signal: NodeJS.Signals) => {
      signals.push(signal);
      return true;
    }) as typeof process.kill;
    try {
      const plugin = new GraphitiPlugin({ graphitiPort: 48123 });
      plugin.setup();
      const startup = (plugin as unknown as { startup: Promise<void> }).startup;
      await assert.rejects(startup, /must differ/);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      process.kill = kill;
      if (previous === undefined) delete process.env.DATABRICKS_APP_PORT;
      else process.env.DATABRICKS_APP_PORT = previous;
    }
  });
});
