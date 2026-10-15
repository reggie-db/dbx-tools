import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { MastraPlugin } from "../src/plugin.ts";

function workflow(id: string) {
  const step = createStep({
    id: `${id}-step`,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async ({ inputData }) => inputData,
  });
  return createWorkflow({
    id,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
  })
    .then(step)
    .commit();
}

describe("Mastra workflow registration", () => {
  it("accepts config and deferred sibling workflows before startup", () => {
    const plugin = new MastraPlugin({
      workflows: { first: workflow("first") },
    });
    const exports = plugin.exports();
    exports.registerWorkflow("second", workflow("second"));
    assert.deepEqual(exports.listWorkflows(), ["first", "second"]);
    assert.throws(
      () => exports.registerWorkflow("first", workflow("duplicate")),
      /already registered/,
    );
  });
});
