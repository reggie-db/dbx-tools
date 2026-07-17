/**
 * Resolution of the shared-projen package root.
 *
 * Deliberately projen-free and dependency-light: this is the
 * `@dbx-tools/shared-projen/engine-root` subpath entry, so the CLI runtime can
 * locate the engine's install without loading the whole projen engine barrel.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "@dbx-tools/node-core";

const ENGINE_PKG = "@dbx-tools/shared-projen";

let resolvedPkgRoot: string | undefined;

/**
 * Absolute path to the shared-projen package root.
 *
 * Walks up from this module with shared-core's {@link project.root} (the nearest
 * package bounded by the enclosing npm/git root), so it resolves both in-repo and
 * when installed as a dependency.
 */
export function resolvePkgRoot(): string {
  if (resolvedPkgRoot) return resolvedPkgRoot;
  const found = project.root(dirname(fileURLToPath(import.meta.url)));
  if (!found) throw new Error(`${ENGINE_PKG} package root not found`);
  return (resolvedPkgRoot = found);
}
