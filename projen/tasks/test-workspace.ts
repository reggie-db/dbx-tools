#!/usr/bin/env -S bun
/** Select dependency-aware workspace tests whose inputs cannot be fixed at synthesis. */
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions, taskPositionals, taskRoot } from "./cli.ts";
import {
  runWorkspaceTests,
  selectWorkspaceTests,
  workspaceGraph,
  writeWorkspaceGraph,
} from "../src/workspace-validation.ts";

const DYNAMIC_TEST_MODES = ["focused", "changed", "graph"] as const;

export const TestWorkspaceOptionsSchema = z
  .object({
    root: z.string().trim().min(1).optional().describe("Repository or workspace root"),
    base: z.string().trim().min(1).optional().describe("Git base used for changed-test selection"),
  })
  .describe("Select workspace tests by dependency graph");

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = taskCommand(
    import.meta.url,
    "Select workspace tests by dependency graph",
    TestWorkspaceOptionsSchema,
  )
    .argument(`[mode]`, `Test mode: ${DYNAMIC_TEST_MODES.join(", ")}`, "graph")
    .argument("[selection...]", "Workspace package names or paths for focused mode");
  const options = await taskOptions(command, TestWorkspaceOptionsSchema, argv);
  const [modeValue = "graph", selections = []] = taskPositionals(command) as [string?, string[]?];
  const mode = z.enum(DYNAMIC_TEST_MODES).parse(modeValue);
  const root = taskRoot(options.root);
  const graph = workspaceGraph(root);
  writeWorkspaceGraph(root, graph);
  if (mode === "graph") return;
  await runWorkspaceTests(root, selectWorkspaceTests(root, graph, mode, selections, options.base));
}

await runTaskMain(import.meta, main);
