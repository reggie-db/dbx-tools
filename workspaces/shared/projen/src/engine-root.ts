/**
 * Locate the `dbx-tools` CLI package root (installed or in-repo dogfood path).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let resolvedEnginePkgRoot: string | undefined;

/**
 * Absolute path to the `dbx-tools` package root.
 *
 * Resolves via `dbx-tools/package.json` when installed; otherwise walks upward
 * from this module to find `workspaces/cli/dbx-tools` during in-repo synth.
 */
export function resolveEnginePkgRoot(): string {
  if (resolvedEnginePkgRoot) return resolvedEnginePkgRoot;
  try {
    const require = createRequire(import.meta.url);
    resolvedEnginePkgRoot = dirname(require.resolve("dbx-tools/package.json"));
  } catch {
    resolvedEnginePkgRoot = resolveInRepoEnginePkgRoot();
  }
  return resolvedEnginePkgRoot;
}

function resolveInRepoEnginePkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const rel of ["cli/dbx-tools", "workspaces/cli/dbx-tools"]) {
      const candidate = join(dir, rel);
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    dir = join(dir, "..");
  }
  throw new Error("dbx-tools package root not found");
}
