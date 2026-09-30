import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { createTestPlugin, createTestPluginContext } from "@databricks/appkit/testing";
import type { AgentToolDefinition, ToolkitEntry } from "@databricks/appkit/beta";
import { log } from "@dbx-tools/shared-core";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { Tool } from "@mastra/core/tools";

import { buildAgents, type MastraTools } from "../src/agents.ts";

interface RecordsPluginConfig extends BasePluginConfig {
  definitions?: AgentToolDefinition[];
  calls?: Array<{ name: string; args: unknown; resourceId?: string }>;
}

class RecordsPlugin extends Plugin<RecordsPluginConfig> {
  static manifest = {
    name: "records",
    displayName: "Records",
    description: "Toolkit test fixture",
    stability: "stable",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"records">;

  getAgentTools() {
    return this.config.definitions ?? [];
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    _signal?: AbortSignal,
    context?: { resourceId?: string },
  ) {
    this.config.calls?.push({ name, args, resourceId: context?.resourceId });
    return args;
  }
}

class MemoryToolkitPlugin extends Plugin {
  static manifest = {
    name: "memory",
    displayName: "Memory",
    description: "Async toolkit test fixture",
    stability: "stable",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"memory">;

  async toolkit(): Promise<Record<string, ToolkitEntry>> {
    return {
      save: {
        __toolkitRef: true,
        pluginName: "memory",
        localName: "save",
        def: {
          name: "save",
          description: "Save memory",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          annotations: { effect: "write" },
        },
        annotations: { effect: "write" },
      },
    };
  }

  async executeAgentTool(_name: string, args: unknown) {
    return args;
  }
}

const recordsPlugin = toPlugin(RecordsPlugin);
const memoryPlugin = toPlugin(MemoryToolkitPlugin);

describe("AppKit toolkit adaptation", () => {
  it("adapts native ToolProvider definitions with options and context", async () => {
    const calls: Array<{
      name: string;
      args: unknown;
      resourceId?: string;
    }> = [];
    const definitions: AgentToolDefinition[] = [
      {
        name: "lookup",
        description: "Look up a record",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { effect: "read", requiresUserContext: true },
      },
      {
        name: "update",
        description: "Update a record",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { effect: "write", requiresUserContext: true },
      },
    ];
    const fixture = createTestPluginContext();
    await fixture.attach(createTestPlugin(recordsPlugin, { definitions, calls }));
    let tools: MastraTools = {};

    await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            tools: async (plugins) => {
              tools = await plugins.records!.toolkit({
                only: ["lookup"],
                rename: { lookup: "find_record" },
              });
              return tools;
            },
          },
        },
      },
      context: fixture.ctx,
      memoryBuilder: {
        forAgent: () => undefined,
        instanceStorage: () => ({}),
      } as never,
      log: log.logger("test/toolkit"),
    });

    assert.deepEqual(Object.keys(tools), ["find_record"]);
    const tool = tools.find_record as Tool;
    assert.equal(tool.description, "Look up a record");
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");
    await tool.execute({ id: "record-1" }, { requestContext });
    assert.deepEqual(calls, [
      {
        name: "lookup",
        args: { id: "record-1" },
        resourceId: "resource-7",
      },
    ]);
  });

  it("awaits asynchronous toolkit providers and preserves write approval", async () => {
    const fixture = createTestPluginContext();
    await fixture.attach(createTestPlugin(memoryPlugin));
    let tools: MastraTools = {};

    await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            tools: async (plugins) => {
              tools = await plugins.memory!.toolkit();
              return tools;
            },
          },
        },
      },
      context: fixture.ctx,
      memoryBuilder: {
        forAgent: () => undefined,
        instanceStorage: () => ({}),
      } as never,
      log: log.logger("test/toolkit"),
    });

    assert.equal((tools.save as Tool).requireApproval, true);
  });

  it("requires approval for legacy destructive annotations", async () => {
    const fixture = createTestPluginContext();
    await fixture.attach(
      createTestPlugin(recordsPlugin, {
        definitions: [
          {
            name: "delete",
            description: "Delete a record",
            parameters: { type: "object" },
            annotations: { destructive: true },
          },
        ],
      }),
    );
    let tools: MastraTools = {};

    await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            tools: async (plugins) => {
              tools = await plugins.records!.toolkit();
              return tools;
            },
          },
        },
      },
      context: fixture.ctx,
      memoryBuilder: {
        forAgent: () => undefined,
        instanceStorage: () => ({}),
      } as never,
      log: log.logger("test/toolkit"),
    });

    assert.equal((tools["records.delete"] as Tool).requireApproval, true);
  });
});
