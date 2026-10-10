#!/usr/bin/env -S bun
/** Interactively remove generated files and installed dependency directories. */
import { relative } from "node:path";
import { log, stringUtils } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { listGeneratedFiles, listNodeModulesDirs, removePaths } from "../src/clean.ts";
import { repoRoot, toPosix } from "../src/packages.ts";

const logger = log.logger("projen:clean");
export const CleanOptionsSchema = z.object({
  yes: z
    .boolean()
    .default(false)
    .describe("Remove every generated and dependency path without prompting")
    .meta({ short: "y", env: [] }),
});

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { yes } = await taskOptions(
    taskCommand(
      import.meta.url,
      "Remove generated files and dependency directories",
      CleanOptionsSchema,
    ),
    CleanOptionsSchema,
    args,
  );

  const files = listGeneratedFiles();
  const nodeModules = listNodeModulesDirs();
  const targets = [...files, ...nodeModules];

  if (targets.length === 0) {
    logger.success("nothing to remove (no generated files or node_modules)");
    process.exit(0);
  }

  const regenHint = (removedNodeModules: boolean): string =>
    removedNodeModules
      ? "reinstall with `bun install`, then `bun run default`"
      : "regenerate with `bun run default`";

  if (yes) {
    const n = removePaths(targets);
    logger.success(
      `removed ${stringUtils.pluralize(n, "path")} (${files.length} generated + ${nodeModules.length} node_modules) - ${regenHint(nodeModules.length > 0)}`,
    );
    process.exit(0);
  }

  if (!process.stdin.isTTY) {
    logger.warn(
      `non-interactive shell: re-run with -y to remove all ${targets.length} paths (${files.length} generated + ${nodeModules.length} node_modules), or run in a terminal to pick`,
    );
    process.exit(1);
  }

  const clack = await import("@clack/prompts");
  clack.intro("projen clean");
  const label = (f: string): string => toPosix(relative(repoRoot, f));
  const picked = await clack.multiselect<string>({
    message: `Select paths to remove (${files.length} generated + ${nodeModules.length} node_modules, all preselected)`,
    options: [
      ...files.map((f) => ({ value: f, label: label(f) })),
      ...nodeModules.map((d) => ({
        value: d,
        label: `${label(d)} (directory)`,
      })),
    ],
    initialValues: [...targets],
    required: false,
  });

  if (typeof picked === "symbol") {
    clack.cancel("clean cancelled - nothing removed");
    process.exit(0);
  }

  if (picked.length === 0) {
    clack.outro("nothing selected - nothing removed");
    process.exit(0);
  }

  const removedNodeModules = picked.some((p) => nodeModules.includes(p));
  const n = removePaths(picked);
  clack.outro(`removed ${stringUtils.pluralize(n, "path")} - ${regenHint(removedNodeModules)}`);
}

await runTaskMain(import.meta, main);
