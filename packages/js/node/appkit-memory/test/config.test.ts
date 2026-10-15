import { describe, expect, test } from "bun:test";

import { resolveMemoryPluginConfig } from "../src/config.ts";

describe("resolveMemoryPluginConfig", () => {
  test("enables Databricks first with a lazy Graphiti fallback", () => {
    const resolved = resolveMemoryPluginConfig({});
    expect(resolved.databricks).toMatchObject({
      memoryStore: expect.stringMatching(/^[a-z][a-z0-9-]{1,54}[a-z0-9]$/),
      mode: "auto",
    });
    expect(resolved.graphiti).toEqual({});
    expect(resolved.saveTurns).toBe("auto");
  });

  test("normalizes an explicit managed-memory resource name", () => {
    expect(
      resolveMemoryPluginConfig({
        databricks: { memoryStore: "memory-stores/support-memory" },
        graphiti: false,
      }).databricks,
    ).toEqual({ memoryStore: "support-memory", mode: "auto" });
  });

  test("treats explicit true as a required Databricks backend", () => {
    expect(resolveMemoryPluginConfig({ databricks: true }).databricks).toMatchObject({
      mode: "required",
    });
  });

  test("keeps Graphiti object fields as environment-layering overrides", () => {
    expect(
      resolveMemoryPluginConfig({
        databricks: false,
        graphiti: { modelClass: "chat-thinking" },
      }).graphiti,
    ).toEqual({ modelClass: "chat-thinking" });
  });

  test("requires at least one backend", () => {
    expect(() => resolveMemoryPluginConfig({ databricks: false, graphiti: false })).toThrow(
      /at least one enabled backend/,
    );
  });
});
