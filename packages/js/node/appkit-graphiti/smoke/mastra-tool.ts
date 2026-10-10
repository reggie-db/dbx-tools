import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GraphitiPlugin } from "../src/plugin.ts";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
  },
});
const profile = values.profile?.trim();
if (!profile) throw new Error("Usage: bun mastra-tool.ts --profile <databricks-profile>");

const graphitiHome = join(tmpdir(), `dbx-tools-graphiti-mastra-${crypto.randomUUID()}`);
const resourceId = `smoke-${crypto.randomUUID()}`;

function assertSuccessful(result: unknown): Record<string, unknown> {
  assert.ok(result && typeof result === "object" && !Array.isArray(result));
  const record = result as Record<string, unknown>;
  assert.equal(typeof record.error, "undefined", JSON.stringify(record));
  return record;
}

async function start(): Promise<GraphitiPlugin> {
  const plugin = new GraphitiPlugin({ profile, graphitiHome });
  await plugin.setup();
  return plugin;
}

let plugin: GraphitiPlugin | undefined;
try {
  plugin = await start();
  const tools = plugin.getAgentTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    [
      "add_memory",
      "add_triplet",
      "search_memory_facts",
      "search_nodes",
      "get_episodes",
      "summarize_saga",
      "build_communities",
      "get_status",
    ],
  );
  assert.match(tools[0]?.description ?? "", /waits for extraction/);

  assertSuccessful(
    await plugin.executeAgentTool(
      "add_memory",
      {
        name: "Employment fact",
        episode_body: "Reggie Pierce works for Databricks.",
        source: "text",
        source_description: "Graphiti AppKit smoke test",
      },
      undefined,
      { resourceId },
    ),
  );
  const firstSearch = assertSuccessful(
    await plugin.executeAgentTool(
      "search_memory_facts",
      { query: "Where does Reggie Pierce work?", max_facts: 10 },
      undefined,
      { resourceId },
    ),
  );
  assert.ok(Array.isArray(firstSearch.facts) && firstSearch.facts.length > 0);

  await plugin.shutdown();
  plugin = await start();
  const restartedSearch = assertSuccessful(
    await plugin.executeAgentTool(
      "search_memory_facts",
      { query: "Reggie Pierce employment", max_facts: 10 },
      undefined,
      { resourceId },
    ),
  );
  assert.ok(Array.isArray(restartedSearch.facts) && restartedSearch.facts.length > 0);
  console.log("Graphiti AppKit Mastra tool smoke test passed");
} finally {
  await plugin?.shutdown();
  await rm(graphitiHome, { recursive: true, force: true });
}
