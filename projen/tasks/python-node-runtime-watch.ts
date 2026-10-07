#!/usr/bin/env -S bun
/** Keep the one package-owned PythonMonkey shim runtime current. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { log } from "@dbx-tools/shared-core";
import { runTaskCommand } from "../src/_task-command.ts";
import { repoRoot } from "../src/packages.ts";
import { watchLoop } from "../src/watch.ts";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

const logger = log.logger("projen:python-node-runtime-watch");

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { project: { type: "string" } },
    strict: true,
  });
  const project = values.project?.trim();
  if (!project) throw new Error("--project is required");

  const projectDirectory = resolve(repoRoot, project);
  const buildScript = resolve(projectDirectory, "build-runtime.ts");
  const shimDirectory = resolve(projectDirectory, "shims");
  for (const path of [buildScript, shimDirectory]) {
    if (!existsSync(path)) throw new Error(`Node runtime input does not exist: ${path}`);
  }

  const build = (): void => runTaskCommand(repoRoot, "bun", [buildScript]);
  await withWorkspaceMutationLock(repoRoot, build);
  logger.success("built shared Python Node runtime");

  watchLoop("python-node-runtime", [buildScript, shimDirectory], () => {
    build();
    logger.success("rebuilt shared Python Node runtime");
  });
}

if (import.meta.main) await main();
