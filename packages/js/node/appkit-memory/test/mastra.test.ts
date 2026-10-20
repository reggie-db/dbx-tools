import { describe, expect, test } from "bun:test";

import { type PluginContextLike } from "@dbx-tools/appkit";
import type { MastraOutputProcessorFactory } from "@dbx-tools/appkit-mastra";

import { attachMastraTurnSaver } from "../src/_mastra.ts";

describe("optional Mastra integration", () => {
  test("registers a memory-owned processor when Mastra is present", async () => {
    let factory: MastraOutputProcessorFactory | undefined;
    const mastraPlugin = {
      exports: () => ({
        registerOutputProcessor: (value: MastraOutputProcessorFactory) => {
          factory = value;
        },
      }),
    };
    const context = {
      getPlugins: () => new Map([["mastra", mastraPlugin]]),
    } as PluginContextLike;

    expect(await attachMastraTurnSaver(context, async () => undefined)).toBe(true);
    expect(factory?.("support")?.id).toBe("appkit_memory_support");
  });

  test("does nothing when Mastra is absent", async () => {
    const context = {
      getPlugins: () => new Map(),
    } as PluginContextLike;

    expect(await attachMastraTurnSaver(context, async () => undefined)).toBe(false);
  });
});
