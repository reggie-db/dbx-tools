/**
 * Locate the `@dbx-tools/shared-projen` package root (installed or in-repo dogfood path).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@dbx-tools/shared-projen";

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
    resolvedPkgRoot = dirname(require.resolve(`${PKG}/package.json`));
  } catch {
    resolvedPkgRoot = resolveInRepoPkgRoot();
  }
  return resolvedPkgRoot;
}

/** @deprecated Use {@link resolvePkgRoot}. */
export function resolveEnginePkgRoot(): string {
  return resolvePkgRoot();
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
  throw new Error(`${PKG} package root not found`);
}
