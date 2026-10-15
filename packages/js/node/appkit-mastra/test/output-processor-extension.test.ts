import { describe, expect, test } from "bun:test";

import type { MastraOutputProcessorFactory } from "../src/agents.ts";
import { MastraPlugin } from "../src/plugin.ts";

describe("Mastra output processor extension", () => {
  test("accepts generic factories before agents are built", () => {
    const plugin = new MastraPlugin({});
    const factory: MastraOutputProcessorFactory = (agentId) => ({
      id: `external_${agentId}`,
      processOutputResult: ({ messageList }) => messageList,
    });

    plugin.exports().registerOutputProcessor(factory);

    expect(
      (
        plugin as unknown as {
          outputProcessorFactories: MastraOutputProcessorFactory[];
        }
      ).outputProcessorFactories,
    ).toEqual([factory]);
  });

  test("rejects registration after agents are built", () => {
    const plugin = new MastraPlugin({});
    Object.assign(plugin, { built: { agents: {}, defaultAgentId: "default" } });

    expect(() =>
      plugin.exports().registerOutputProcessor(() => ({
        id: "late",
        processOutputResult: ({ messageList }) => messageList,
      })),
    ).toThrow(/before agents are built/);
  });
});
