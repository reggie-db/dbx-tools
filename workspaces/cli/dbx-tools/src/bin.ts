/**
 * Binary discovery and execution (pnpm, engine bin scripts).
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace } from "@dbx-tools/shared-projen";
import { resolveEnginePkgRoot } from "@dbx-tools/shared-projen/engine-root";
import { runPnpm, resolvePnpmArgv } from "@dbx-tools/shared-projen/pnpm";

export { resolveEnginePkgRoot, runPnpm, resolvePnpmArgv };

/** Absolute path to this CLI package root (the folder that contains `bin/`). */
export const ENGINE_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function engineBinScript(name: string): string {
  return join(resolveEnginePkgRoot(), "bin", name);
}

/** Projen task exec: `tsx <rel>/bin/<script>` from the monorepo root. */
export function tsxBinTaskExec(root: string, script: string, args = ""): string {
  const rel = workspace.toPosix(relative(root, engineBinScript(script)));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}
