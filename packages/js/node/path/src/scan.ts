/**
 * Shared scan options used by file discovery and watching.
 *
 * Reuse these types so path-based utilities agree on roots, ignore policy,
 * symlink behavior, and cancellation rather than inventing parallel option
 * shapes.
 *
 * @module
 */

import type { IgnorePatternOptions } from "./ignore.ts";
import { PathMatchInput } from "./match.ts";

/** Shared default used by file discovery and watching to avoid traversing symlinks. */
export const FOLLOW_SYMLINKS_DEFAULT = false;

/** Common root, ignore, symlink, and cancellation settings for filesystem scans. */
export interface FileScanOptions {
  /**
   * Base directory used to resolve relative paths.
   */
  cwd?: string;

  /**
   * Ignore files or directories matching these patterns or predicates.
   */
  ignore?: PathMatchInput | readonly PathMatchInput[];
  ignoreOptions?: FileScanIgnoreOptions;
  /**
   * Follow symbolic links.
   *
   * Maps to:
   *   glob: follow
   *   chokidar: followSymlinks
   */
  followSymlinks?: boolean;

  /**
   * Abort an in-progress operation.
   *
   * Ignored by chokidar after the watcher has been created.
   */
  signal?: AbortSignal;
}

/** Options controlling built-in and repository `.gitignore` matching. */
export interface FileScanIgnoreOptions extends IgnorePatternOptions {
  /**
   * Load root and nested `.gitignore` files using Git-compatible semantics.
   * Defaults to false.
   */
  git?: boolean;
}
