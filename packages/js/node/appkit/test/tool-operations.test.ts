import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeFromRegistry, toolsFromRegistry } from "@databricks/appkit/beta";
import { z } from "zod";
import { defineOperations, toolRegistryFromOperations } from "../src/tool-operations.ts";

describe("Zod AppKit operations", () => {
  it("derives tool definitions, validation, and approval annotations from one contract", async () => {
    const operations = defineOperations({
      lookup: {
        schema: z
          .object({ id: z.string().min(1) })
          .strict()
          .describe("Look up one record.")
          .meta({
            appkitTool: { agentTool: true, effect: "read", requiresUserContext: true },
          }),
        execute: ({ id }) => ({ id }),
      },
      reset: {
        schema: z
          .object({ id: z.string().min(1) })
          .strict()
          .describe("Reset one record.")
          .meta({
            appkitTool: {
              effect: "write",
              agentTool: true,
              approval: true,
              requiresUserContext: true,
              idempotent: true,
            },
          }),
        execute: ({ id }) => ({ reset: id }),
      },
    });

    const registry = toolRegistryFromOperations(operations);
    const definitions = toolsFromRegistry(registry);

    assert.deepEqual(
      definitions.map(({ name }) => name),
      ["lookup", "reset"],
    );
    assert.deepEqual(definitions[0]?.annotations, {
      effect: "read",
      requiresUserContext: true,
    });
    assert.deepEqual(definitions[1]?.annotations, {
      effect: "write",
      destructive: true,
      requiresUserContext: true,
      idempotent: true,
    });
    assert.deepEqual(await executeFromRegistry(registry, "lookup", { id: "one" }), { id: "one" });
    assert.match(
      String(await executeFromRegistry(registry, "lookup", { id: "" })),
      /too small|at least 1 character/i,
    );
  });

  it("requires every operation schema to describe the agent-visible action", () => {
    const operations = defineOperations({
      missing: {
        schema: z
          .object({})
          .strict()
          .meta({ appkitTool: { agentTool: true } }),
        execute: () => undefined,
      },
    });

    assert.throws(
      () => toolRegistryFromOperations(operations),
      /operation missing requires a Zod schema description/,
    );
  });

  it("only exposes operations that explicitly opt in", () => {
    const registry = toolRegistryFromOperations(
      defineOperations({
        internal: {
          schema: z.object({}).strict().describe("Internal operation."),
          execute: () => undefined,
        },
      }),
    );

    assert.deepEqual(toolsFromRegistry(registry), []);
  });
});
