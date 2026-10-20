/**
 * Local host path helpers for {@link LocalFileSystem}.
 *
 * Home / temp directory resolution lives in {@link ./os-path.ts}; this module
 * owns `~` expansion and root resolution against that home.
 *
 * @module
 */

import path from "node:path";
import { expandHome } from "@dbx-tools/shared-fs";
import { resolveLocalHome, type ResolveOsPathsOptions } from "./os-path.ts";

/**
 * Expand `~` / `~/...` against {@link home}, joining with the HOST separator.
 * Non-home inputs are returned trimmed and unchanged.
 */
export function expandLocalHomePath(input: string, home: string = resolveLocalHome()): string {
  return expandHome(input, home, path.join);
}

/**
 * Resolve a local filesystem root: expand `~` when needed, then `path.resolve`
 * (so relative roots still land under `process.cwd()`).
 */
export function resolveLocalRoot(root: string, options: ResolveOsPathsOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return path.resolve(cwd, expandLocalHomePath(root, resolveLocalHome(options)));
}
