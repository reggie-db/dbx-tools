/**
 * Resolution of the projen engine package root.
 *
 * Deliberately projen-free and dependency-light, so locating the engine's
 * install never pulls in projen itself.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "@dbx-tools/core";
import { functionModule } from "@dbx-tools/shared-core";

const ENGINE_PKG = "@dbx-tools/projen";

/**
 * Absolute path to the projen engine package root.
 *
 * Walks up from this module with shared-core's {@link project.root} (the nearest
 * package bounded by the enclosing npm/git root), so it resolves both in-repo and
 * when installed as a dependency. Memoized with shared-core's
 * {@link functionModule.memoize}, which caches only a successful result - a
 * throw is retried on the next call.
 */
export const resolvePkgRoot = functionModule.memoize((): string => {
  const found = project.root(dirname(fileURLToPath(import.meta.url)));
  if (!found) throw new Error(`${ENGINE_PKG} package root not found`);
  return found;
});
