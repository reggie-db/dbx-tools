/**
 * Repository-consistent file watching over Chokidar.
 *
 * Reuse `watchFiles()` when live workflows must match `findFiles()`
 * discovery and the central ignore catalogue. The wrapper expands globs once,
 * prunes ignored directories consistently, and preserves Chokidar's native
 * watcher result for callers.
 *
 * @module
 */

import { once } from "node:events";
import { readFileSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "path";
import { errorUtils, log } from "@dbx-tools/shared-core";
import { ChokidarOptions, MatchFunction, watch, type FSWatcher } from "chokidar";
import { hasMagic } from "glob";
import { findFiles, type FileFindOptions } from "./find.ts";
import { GitIgnore } from "./git-ignore.ts";
import { ignorePathMatcher } from "./ignore.ts";
import { pathMatchTests } from "./match.ts";
import { FileScanIgnoreOptions, FileScanOptions, FOLLOW_SYMLINKS_DEFAULT } from "./scan.ts";

const logger = log.logger("path/watch");

/** Chokidar options extended with the shared dbx-tools ignore configuration. */
export interface FileWatchOptions
  extends Omit<ChokidarOptions, "ignored">, Omit<FileScanOptions, "ignore"> {
  ignore?: string | string[] | MatchFunction | MatchFunction[];
}

interface NormalizedFileWatchOptions extends Omit<FileWatchOptions, "ignore" | "ignoreOptions"> {
  gitIgnore?: GitIgnore;
  ignored: MatchFunction;
}

interface GitIgnoreControls {
  attach(watcher: FSWatcher, watchPaths: readonly string[]): void;
}

/**
 * Watches files and directories for real-time changes, applying the shared
 * ignore groups so it prunes the same paths {@link findFiles} skips for the
 * same patterns.
 */
export async function watchFiles(
  paths: string | string[],
  options?: FileWatchOptions,
): Promise<FSWatcher> {
  const normalized = await toNormalizedFileWatchOptions(options);
  const { gitIgnore, ignored, cwd, followSymlinks, ...chokidarOptions } = normalized;
  const { paths: literals, globs } = partitionPaths(paths);

  let watchPaths: string[];
  if (globs.length > 0) {
    const distinctWatchPaths = new Set(literals);
    for await (const path of findFiles(globs, toFindFilesOptions(normalized))) {
      distinctWatchPaths.add(path);
    }
    watchPaths = [...distinctWatchPaths];
  } else {
    watchPaths = literals;
  }

  const controls = gitIgnore
    ? await createGitIgnoreControls(gitIgnore, {
        cwd,
        followSymlinks,
        ignoreOptions: options?.ignoreOptions,
        persistent: chokidarOptions.persistent,
      })
    : undefined;
  const watcher = watch(watchPaths, {
    ...chokidarOptions,
    cwd,
    followSymlinks,
    ignored,
  });
  controls?.attach(watcher, watchPaths);
  return watcher;
}

function partitionPaths(paths: string | string[]): { paths: string[]; globs: string[] } {
  const globs: string[] = [];
  const literals: string[] = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    (hasMagic(path) ? globs : literals).push(path);
  }
  return { paths: literals, globs };
}

/**
 * Builds {@link NormalizedFileWatchOptions} first: all caller ignore inputs and
 * built-in groups are consolidated into one chokidar {@link MatchFunction}. When
 * `stats` marks a directory, the matcher also tests `path + "/"` for pruning.
 */
async function toNormalizedFileWatchOptions(options?: FileWatchOptions): Promise<
  NormalizedFileWatchOptions & {
    cwd: string;
    followSymlinks: boolean;
  }
> {
  const { cwd, ignore, followSymlinks, ignoreOptions, ...chokidarOptions } = options ?? {};
  const root = cwd ?? process.cwd();
  const gitIgnore = ignoreOptions?.git
    ? await GitIgnore.load(root, { ignoreOptions, followSymlinks })
    : undefined;
  return {
    ...chokidarOptions,
    cwd: root,
    followSymlinks: followSymlinks ?? FOLLOW_SYMLINKS_DEFAULT,
    ...(gitIgnore ? { gitIgnore } : {}),
    ignored: toWatchMatchFunction(ignore, ignoreOptions, root, gitIgnore),
  };
}

/** Glob expansion reuses the normalized ignore matcher as a cwd-relative path predicate. */
function toFindFilesOptions(
  normalized: NormalizedFileWatchOptions & { cwd: string; followSymlinks: boolean },
): FileFindOptions {
  const { ignored, cwd, followSymlinks } = normalized;
  return {
    cwd,
    followSymlinks,
    ignore: (path) => ignored(path, undefined),
  };
}

/**
 * Consolidates built-in ignore groups, caller glob patterns, and caller
 * {@link MatchFunction}s into one ignore test. Directory pruning uses `stats`
 * when chokidar supplies it; glob expansion passes `undefined`.
 */
function toWatchMatchFunction(
  ignore: FileWatchOptions["ignore"] | undefined,
  ignoreOptions: FileScanIgnoreOptions | undefined,
  cwd: string,
  gitIgnore?: GitIgnore,
): MatchFunction {
  const patterns: string[] = [];
  const functions: MatchFunction[] = [];

  if (ignore !== undefined) {
    for (const item of Array.isArray(ignore) ? ignore : [ignore]) {
      if (typeof item === "string") patterns.push(item);
      else functions.push(item);
    }
  }

  let matcher = ignorePathMatcher(ignoreOptions);
  if (patterns.length > 0) matcher = matcher.or(...pathMatchTests(...patterns));

  const matchPath = (path: string, stats?: Stats): boolean => {
    const rel = toCwdRelativePath(path, cwd);
    gitIgnore?.refreshPathSync(rel);
    if (gitIgnore?.ignores(rel, stats?.isDirectory() ?? false)) return true;
    if (matcher(rel)) return true;
    for (const fn of functions) {
      if (fn(rel, stats)) return true;
    }
    if (stats?.isDirectory()) {
      const directoryPath = rel + "/";
      if (matcher(directoryPath)) return true;
      for (const fn of functions) {
        if (fn(directoryPath, stats)) return true;
      }
    }
    return false;
  };

  return matchPath;
}

/**
 * Start the control-file watcher before the primary watcher.
 *
 * Waiting for its initial scan closes the event-loss window where a newly
 * created `.gitignore` could be missed while the primary watcher was already
 * accepting files under stale rules.
 */
async function createGitIgnoreControls(
  gitIgnore: GitIgnore,
  options: {
    cwd: string;
    followSymlinks: boolean;
    ignoreOptions?: FileScanIgnoreOptions;
    persistent?: boolean;
  },
): Promise<GitIgnoreControls> {
  const builtInIgnore = ignorePathMatcher(options.ignoreOptions);
  const controls = watch(".", {
    atomic: false,
    cwd: options.cwd,
    followSymlinks: options.followSymlinks,
    // Include the initial scan so a control file created while this secondary
    // watcher starts cannot fall between its scan and live event subscription.
    ignoreInitial: false,
    persistent: options.persistent,
    ignored(path, stats) {
      const relativePath = toCwdRelativePath(path, options.cwd);
      if (GitIgnore.isFile(relativePath)) return false;
      if (builtInIgnore(relativePath) || builtInIgnore(`${relativePath}/`)) return true;
      return stats ? !stats.isDirectory() : false;
    },
  });
  let target: { watcher: FSWatcher; watchPaths: readonly string[] } | undefined;
  let pendingError: unknown;
  const refreshTarget = (): void => {
    target?.watcher.add([...target.watchPaths]);
  };
  const reload = (path: string): void => {
    try {
      gitIgnore.set(path, readFileSync(resolve(options.cwd, path), "utf8"));
      refreshTarget();
      logger.debug(".gitignore updated", { path });
    } catch (error) {
      logger.warn("failed to reload .gitignore", {
        path,
        error: errorUtils.toError(error),
      });
    }
  };
  controls.on("add", reload);
  controls.on("change", reload);
  controls.on("unlink", (path) => {
    gitIgnore.delete(path);
    refreshTarget();
    logger.debug(".gitignore removed", { path });
  });
  controls.on("error", (error) => {
    if (target) target.watcher.emit("error", error);
    else pendingError = error;
  });
  await once(controls, "ready");
  return {
    attach(watcher, watchPaths) {
      target = { watcher, watchPaths };
      if (pendingError) {
        queueMicrotask(() => watcher.emit("error", pendingError));
        pendingError = undefined;
      }
      const close = watcher.close.bind(watcher);
      watcher.close = async () => {
        await Promise.all([close(), controls.close()]);
      };
    },
  };
}

/** Aligns chokidar paths with the cwd-relative form {@link findFiles} uses. */
function toCwdRelativePath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel;
}

// Manual demo: run this file directly (`bun src/watch.ts [dir]`) to watch a tree
// and log every file event as it happens. Defaults to this package.
if (import.meta.main) {
  const cwd = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
  console.log("--- Starting File Watcher ---");
  console.log(`Working Directory: ${cwd}`);

  const watcher = await watchFiles("**/src/**", {
    cwd,
    ignoreInitial: false,
    ignore: ["**/index.ts", "**/core/**"],
    ignoreOptions: {
      temp: false,
    },
  });
  watcher.on("all", (event: string, path: string) => {
    console.log(`[${event.toUpperCase()}] ${path}`);
  });
  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });
  console.log("Watcher started");
}
