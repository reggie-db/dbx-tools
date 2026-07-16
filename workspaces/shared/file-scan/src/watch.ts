import { Stats } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { ChokidarOptions, MatchFunction, watch } from "chokidar";
import { hasMagic } from "glob";
import { findFiles, type FileFindOptions } from "./find";
import { ignorePathMatcher } from "./ignore";
import { pathMatchTests } from "./match";
import { FileScanIgnoreOptions, FileScanOptions, FOLLOW_SYMLINKS_DEFAULT } from "./scan";

export interface FileWatchOptions
  extends Omit<ChokidarOptions, "ignored">, Omit<FileScanOptions, "ignore"> {
  ignore?: string | string[] | MatchFunction | MatchFunction[];
}

interface NormalizedFileWatchOptions extends Omit<FileWatchOptions, "ignore" | "ignoreOptions"> {
  ignored: MatchFunction;
}

/**
 * Watches files and directories for real-time changes, applying the shared
 * ignore groups so it prunes the same paths {@link findFiles} skips for the
 * same patterns.
 */
export function watchFiles(paths: string | string[], options?: FileWatchOptions) {
  const normalized = toNormalizedFileWatchOptions(options);
  const { ignored, cwd, followSymlinks, ...chokidarOptions } = normalized;
  const { paths: literals, globs } = partitionPaths(paths);

  let watchPaths: string[];
  if (globs.length > 0) {
    const distinctWatchPaths = new Set(literals);
    for (const path of findFiles(globs, toFindFilesOptions(normalized))) {
      distinctWatchPaths.add(path);
    }
    watchPaths = [...distinctWatchPaths];
  } else {
    watchPaths = literals;
  }

  return watch(watchPaths, {
    ...chokidarOptions,
    cwd,
    followSymlinks,
    ignored,
  });
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
function toNormalizedFileWatchOptions(options?: FileWatchOptions): NormalizedFileWatchOptions & {
  cwd: string;
  followSymlinks: boolean;
} {
  const { cwd, ignore, followSymlinks, ignoreOptions, ...chokidarOptions } = options ?? {};
  return {
    ...chokidarOptions,
    cwd: cwd ?? process.cwd(),
    followSymlinks: followSymlinks ?? FOLLOW_SYMLINKS_DEFAULT,
    ignored: toWatchMatchFunction(ignore, ignoreOptions, cwd ?? process.cwd()),
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

/** Aligns chokidar paths with the cwd-relative form {@link findFiles} uses. */
function toCwdRelativePath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel;
}

// Manual demo: run this file directly (e.g. `tsx src/watch.ts`) to watch this
// package and log every file event as it happens.
if (import.meta.main) {
  const dir = import.meta.dirname;
  console.log("--- Starting File Watcher ---");
  let cwd = resolve(dir, "..");
  cwd = "/Users/reggie.pierce/Projects/github-reggie-db/dbx-tools";
  console.log(`Working Directory: ${cwd}`);

  const watcher = watchFiles("**/src/**", {
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
