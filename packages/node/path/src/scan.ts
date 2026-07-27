import { IgnorePatternOptions } from "./ignore";
import { PathMatchInput } from "./match";

export const FOLLOW_SYMLINKS_DEFAULT = false;

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

/** Options controlling the generated ignore pattern list. */
export type FileScanIgnoreOptions = IgnorePatternOptions;
