import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IAppRouter } from "@databricks/appkit";
import { GraphitiPlugin, ensureGraphitiPython } from "../src/plugin.ts";

describe("GraphitiPlugin routes", () => {
  it("installs the matching Python package when the module is absent", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await ensureGraphitiPython("python3", async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) throw new Error("missing");
    });

    assert.deepEqual(calls[0], {
      file: "python3",
      args: ["-c", "import dbx_tools.graphiti"],
    });
    assert.equal(calls[1]?.file, "python3");
    assert.match(calls[1]?.args.at(-1) ?? "", /^dbx-tools-graphiti==0\.6\./);
  });

  it("registers the MCP transport on the AppKit server", () => {
    const routes: Array<{ method: string; path: string }> = [];
    const router = Object.fromEntries(
      ["get", "post", "delete"].map((method) => [
        method,
        (path: string) => routes.push({ method, path }),
      ]),
    ) as unknown as IAppRouter;
    const plugin = new GraphitiPlugin({});

    plugin.injectRoutes(router);

    assert.deepEqual(routes, [
      { method: "get", path: "/mcp" },
      { method: "post", path: "/mcp" },
      { method: "delete", path: "/mcp" },
    ]);
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
    process.env.DATABRICKS_APP_PORT = "48123";
    try {
      await assert.rejects(
        new GraphitiPlugin({ graphitiPort: 48123 }).setup(),
        /differ from DATABRICKS_APP_PORT/,
      );
    } finally {
      if (previous === undefined) delete process.env.DATABRICKS_APP_PORT;
      else process.env.DATABRICKS_APP_PORT = previous;
    }
  });
});
