import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { MemoryPlugin } from "../src/plugin.ts";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
  },
});
const profile = values.profile?.trim();
if (!profile) throw new Error("Usage: bun mastra-tool.ts --profile <databricks-profile>");

const graphitiHome = join(tmpdir(), `dbx-tools-memory-graphiti-${crypto.randomUUID()}`);
const resourceId = `smoke-${crypto.randomUUID()}`;

async function start(): Promise<MemoryPlugin> {
  const plugin = new MemoryPlugin({
    databricks: false,
    graphiti: { profile, graphitiHome },
  });
  await plugin.setup();
  return plugin;
}

let plugin: MemoryPlugin | undefined;
try {
  plugin = await start();
  assert.deepEqual(
    plugin.getAgentTools().map(({ name }) => name),
    ["remember", "recall_memory"],
  );

  const saved = await plugin.executeAgentTool(
    "remember",
    {
      path: "/facts/employment.md",
      content: "Reggie Pierce works for Databricks.",
      description: "Employment fact",
    },
    undefined,
    { resourceId },
  );
  assert.equal((saved as { backend?: string }).backend, "graphiti");

  const firstSearch = await plugin.executeAgentTool(
    "recall_memory",
    { query: "Where does Reggie Pierce work?", limit: 10 },
    undefined,
    { resourceId },
  );
  assert.ok((firstSearch as { memories?: unknown[] }).memories?.length);

  await plugin.shutdown();
  plugin = await start();
  const restartedSearch = await plugin.executeAgentTool(
    "recall_memory",
    { query: "Reggie Pierce employment", limit: 10 },
    undefined,
    { resourceId },
  );
  assert.ok((restartedSearch as { memories?: unknown[] }).memories?.length);
} finally {
  await plugin?.shutdown();
  await rm(graphitiHome, { recursive: true, force: true });
}
