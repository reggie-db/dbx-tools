#!/usr/bin/env -S npx tsx
import { relative } from "node:path";
import { listGeneratedFiles, listNodeModulesDirs, removePaths } from "../src/clean";
import { repoRoot, toPosix } from "../src/workspace";
import { logger } from "../src/log";

const log = logger.withTag("projen:clean");
const yes = process.argv.includes("-y") || process.argv.includes("--yes");

const files = listGeneratedFiles();
const nodeModules = listNodeModulesDirs();
const targets = [...files, ...nodeModules];

if (targets.length === 0) {
  log.success("nothing to remove (no generated files or node_modules)");
  process.exit(0);
}

const regenHint = (removedNodeModules: boolean): string =>
  removedNodeModules
    ? "reinstall with `pnpm install`, then `pnpm exec projen`"
    : "regenerate with `pnpm exec projen`";

if (yes) {
  const n = removePaths(targets);
  log.success(
    `removed ${n} path${n === 1 ? "" : "s"} (${files.length} generated + ${nodeModules.length} node_modules) - ${regenHint(nodeModules.length > 0)}`,
  );
  process.exit(0);
}

if (!process.stdin.isTTY) {
  log.warn(
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

if (clack.isCancel(picked)) {
  clack.cancel("clean cancelled - nothing removed");
  process.exit(0);
}

if (picked.length === 0) {
  clack.outro("nothing selected - nothing removed");
  process.exit(0);
}

const removedNodeModules = picked.some((p) => nodeModules.includes(p));
const n = removePaths(picked);
clack.outro(`removed ${n} path${n === 1 ? "" : "s"} - ${regenHint(removedNodeModules)}`);
