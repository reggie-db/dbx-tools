/**
 * Local host path helpers for {@link LocalFileSystem}.
 *
 * Home / temp directory resolution lives in {@link ./os-path.ts}; this module
 * owns `~` expansion and root resolution against that home.
 *
 * @module
 */

import path from "node:path";
import { resolveLocalHome, type ResolveOsPathsOptions } from "./os-path.ts";

export {
  APP_HOME,
  clearOsPathsCache,
  resolveLocalHome,
  resolveLocalTemp,
  resolveOsPaths,
  type OsPaths,
  type ResolveOsPathsOptions,
} from "./os-path.ts";

/** True when {@link input} is `~` or a path under `~/`. */
export function isHomeRelativePath(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
}

/**
 * Expand `~` / `~/...` against {@link home}. Non-home inputs are returned
 * trimmed and unchanged.
 */
export function expandLocalHomePath(input: string, home: string = resolveLocalHome()): string {
  const trimmed = input.trim();
  if (!isHomeRelativePath(trimmed)) return trimmed;
  if (!home.trim()) {
    throw new TypeError("Local home expansion requires a non-empty home directory");
  }
  if (trimmed === "~") return home;
  const rest = trimmed.slice(1).replace(/^[\\/]+/, "");
  return rest ? path.join(home, rest) : home;
}

/**
 * Resolve a local filesystem root: expand `~` when needed, then `path.resolve`
 * (so relative roots still land under `process.cwd()`).
 */
export function resolveLocalRoot(root: string, options: ResolveOsPathsOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return path.resolve(cwd, expandLocalHomePath(root, resolveLocalHome(options)));
}
