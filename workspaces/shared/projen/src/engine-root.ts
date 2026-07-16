/**
 * Resolution of the shared-projen package root.
 *
 * Deliberately projen-free and dependency-light: this is the
 * `@dbx-tools/shared-projen/engine-root` subpath entry, so the CLI runtime can
 * locate the engine's install without loading the whole projen engine barrel.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_PKG = "@dbx-tools/shared-projen";

let resolvedPkgRoot: string | undefined;

/**
 * Absolute path to the shared-projen package root.
 *
 * Resolves via `@dbx-tools/shared-projen/package.json` when installed; otherwise
 * walks upward from this module to find `workspaces/shared/projen` during in-repo synth.
 */
export function resolvePkgRoot(): string {
  if (resolvedPkgRoot) return resolvedPkgRoot;
  try {
    const require = createRequire(import.meta.url);
    resolvedPkgRoot = dirname(require.resolve(`${ENGINE_PKG}/package.json`));
  } catch {
    resolvedPkgRoot = resolveInRepoPkgRoot();
  }
  return resolvedPkgRoot;
}

function resolveInRepoPkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const rel of ["shared/projen", "workspaces/shared/projen"]) {
      const candidate = join(dir, rel);
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    dir = join(dir, "..");
  }
  throw new Error(`${ENGINE_PKG} package root not found`);
}
