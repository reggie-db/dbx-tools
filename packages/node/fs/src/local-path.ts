/**
 * Local host path helpers for {@link LocalFileSystem}.
 *
 * Home / temp directory resolution lives in {@link ./os-path.ts}; this module
 * owns `~` expansion and root resolution against that home.
 *
 * @module
 */

import path from "node:path";
import { posixPath } from "@dbx-tools/shared-fs";
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

/** True when {@link input} is `~` or a path under `~/`. See {@link posixPath.isHomeRelativePath}. */
export const isHomeRelativePath = posixPath.isHomeRelativePath;

/**
 * Expand `~` / `~/...` against {@link home}, joining with the HOST separator.
 * Non-home inputs are returned trimmed and unchanged.
 */
export function expandLocalHomePath(input: string, home: string = resolveLocalHome()): string {
  return posixPath.expandHome(input, home, path.join);
}

/**
 * Resolve a local filesystem root: expand `~` when needed, then `path.resolve`
 * (so relative roots still land under `process.cwd()`).
 */
export function resolveLocalRoot(root: string, options: ResolveOsPathsOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return path.resolve(cwd, expandLocalHomePath(root, resolveLocalHome(options)));
}
