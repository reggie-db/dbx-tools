import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolDefinition } from "@databricks/appkit/beta";
import { plugin } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { Tool } from "@mastra/core/tools";

import { buildAgents, type MastraTools } from "../src/agents.ts";

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
    const provider = {
      getAgentTools: () => definitions,
      executeAgentTool: async (
        name: string,
        args: unknown,
        _signal?: AbortSignal,
        context?: { resourceId?: string },
      ) => {
        calls.push({ name, args, resourceId: context?.resourceId });
        return args;
      },
    };
    const context = {
      getPlugins: () => new Map([["records", provider]]),
    } as unknown as plugin.PluginContextLike;
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
      context,
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
    const provider = {
      toolkit: async () => ({
        save: {
          __toolkitRef: true as const,
          pluginName: "memory",
          localName: "save",
          def: {
            name: "save",
            description: "Save memory",
            parameters: {
              type: "object" as const,
              properties: { value: { type: "string" as const } },
              required: ["value"],
            },
            annotations: { effect: "write" as const },
          },
          annotations: { effect: "write" as const },
        },
      }),
      executeAgentTool: async (_name: string, args: unknown) => args,
    };
    const context = {
      getPlugins: () => new Map([["memory", provider]]),
    } as unknown as plugin.PluginContextLike;
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
      context,
      memoryBuilder: {
        forAgent: () => undefined,
        instanceStorage: () => ({}),
      } as never,
      log: log.logger("test/toolkit"),
    });

    assert.equal((tools.save as Tool).requireApproval, true);
  });
});
