import { resolve } from "path";
import { ChokidarOptions, Matcher, MatchFunction, watch } from "chokidar";
import { ignoreMatcher, IgnorePatternsOptions } from "./match";

/** Options for {@link fileWatch}: chokidar options plus the shared ignore-group toggles. */
export type FileWatchOptions = ChokidarOptions & {
  /** Toggles for the built-in ignore groups, forwarded to {@link ignoreMatcher}. */
  ignoreOptions?: IgnorePatternsOptions;
};

/**
 * Watches files and directories for real-time changes, applying the shared
 * ignore groups (via {@link normalizeIgnored}) so it prunes the same paths
 * {@link fileScan} skips for the same patterns.
 */
export function fileWatch(paths: string | string[], options?: FileWatchOptions) {
  const { ignored, ignoreOptions: ignoredOptions, ...chokidarOptions } = options ?? {};
  return watch(paths, {
    ...chokidarOptions,
    ignored: Array.from(normalizeIgnored(ignored, ignoredOptions)),
  });
}

/**
 * Normalizes Chokidar ignored configurations, applying dotfile defaults
 * and generating performance-optimized directory pruning filters.
 */
function* normalizeIgnored(
  ignored: Matcher | Matcher[] | undefined,
  ignoredOptions: IgnorePatternsOptions | undefined,
): Generator<Matcher, void, void> {
  const ignoredArray =
    ignored === undefined ? [] : Array.isArray(ignored) ? [...ignored] : [ignored];
  const matcherIgnorePatterns = new Set<string>();
  for (const value of ignoredArray) {
    if (typeof value !== "string") {
      yield value;
    } else {
      matcherIgnorePatterns.add(value);
    }
  }
  const matcher = ignoreMatcher(ignoredOptions, ...matcherIgnorePatterns);
  const matchFunction: MatchFunction = (path, stats) => matcher.match(path, stats?.isDirectory());
  yield matchFunction;
}

// Manual demo: run this file directly (e.g. `tsx src/watch.ts`) to watch this
// package and log every file event as it happens.
if (import.meta.main) {
  const dir = import.meta.dirname;
  console.log("--- Starting File Watcher ---");
  const cwd = resolve(dir, "..");
  console.log(`Working Directory: ${cwd}`);

  const watcher = fileWatch(cwd, {
    ignoreInitial: false,
    ignored: ["**/index.ts"],
    ignoreOptions: {
      tempPatterns: false,
    },
  });
  watcher.on("all", (event: string, path: string) => {
    console.log(`[${event.toUpperCase()}] ${path}`);
  });
}
