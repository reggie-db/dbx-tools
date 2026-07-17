/**
 * Built-in ignore glob patterns for file scanning and watching.
 *
 * This module owns the pattern catalog and option toggles only. Each group is
 * compiled into {@link PathMatchPredicate} instances via {@link toPathMatcher};
 * composition (`and`/`or`/`negate`) lives in {@link ./match}.
 *
 * Consumers:
 * - {@link ignorePatterns} - yields the enabled glob strings (for projen prettier/gitignore).
 * - {@link ignorePathMatcher} - returns a single {@link PathMatcher} for {@link findFiles}
 *   and {@link watchFiles}.
 */

import { exec } from "@dbx-tools/core";
import { functionModule, object, type Sequence } from "@dbx-tools/shared-core";
import { PathMatcher, PathMatchPredicate, toPathMatcher } from "./match";
import { directoryNamePattern, fileExtensionPattern } from "./pattern";

/** Toggles for each built-in ignore group; omitted flags default to `true`. */
export type IgnorePatternOptions = {
  /** Build artifacts, dependency dirs, caches, logs, and OS junk files. */
  defaults?: boolean;
  /** Hidden dot-files and dot-directories (`.git`, `.vscode`, `.gitignore`, etc.). */
  dot?: boolean;
  /** Temporary directories (`tmp`, `.tmp`, `scratch`, etc.). */
  temp?: boolean;
  /** Test directories and `*.test.*` / `*.spec.*` naming conventions. */
  test?: boolean;
  /**
   * Lockfile ignore group (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
   * `bun.lockb`, etc.).
   *
   * - `true` - always ignore lockfiles.
   * - `false` - never ignore lockfiles.
   * - `"auto"` (default) - ignore when the active npm registry is not the public
   *   npm registry (`registry.npmjs.org`), e.g. a company-internal registry.
   */
  lock?: boolean | "auto";
};

/**
 * Memoized probe for {@link IgnorePatternOptions.lock} `"auto"`.
 *
 * Runs `npm`/`pnpm`/`yarn config get registry` (whichever succeeds first) and
 * returns `true` when the registry host is not `registry.npmjs.org`.
 */
const lockIgnoreMatchersAutoEnabled = functionModule.memoize(() => {
  let registryUrl: URL | undefined;
  for (const command of ["npm", "pnpm", "yarn"]) {
    const result = exec.spawnSync(command, ["config", "get", "registry"], {
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (result.exitCode !== 0) continue;
    const output = result.stdout;
    if (output && output.includes("://")) {
      const url = new URL(output);
      if (url.protocol && url.hostname) {
        registryUrl = url;
        break;
      }
    }
  }
  if (registryUrl && registryUrl.hostname !== "registry.npmjs.org") {
    return true;
  }
  return false;
});

/** Resolves whether the lockfile ignore group is enabled for the given options. */
function lockIgnoreMatchersEnabled(options?: IgnorePatternOptions): boolean {
  const value = options?.lock ?? "auto";
  if (value === "auto") {
    return lockIgnoreMatchersAutoEnabled();
  }
  return value;
}

/**
 * Compiles glob strings into a `{ [glob]: PathMatchPredicate }` map.
 *
 * Keying by the source glob de-dupes and keeps each matcher beside its pattern.
 */
function compileMatchers(patterns: readonly string[]): Record<string, PathMatchPredicate> {
  return Object.fromEntries(patterns.map((glob) => [glob, toPathMatcher(glob)]));
}

/** Build artifacts, dependency directories, caches, logs, and OS files. */
const defaultIgnoreMatchers = compileMatchers([
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/Desktop.ini",
  ...["log", "tsbuildinfo"].map((ext) => fileExtensionPattern(ext)),
  "**/*-debug.log*",
  "**/yarn-error.log*",
  ...[
    "node_modules",
    "bower_components",
    "jspm_packages",
    "dist",
    "lib",
    "build",
    "out",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".pnpm-store",
    ".nyc_output",
  ].map((name) => directoryNamePattern(name)),
]);

/** Hidden dot-files and dot-directories such as `.git`, `.vscode`, `.idea`, etc. */
const dotIgnoreMatchers = compileMatchers(
  [".*"].flatMap((glob) => [`**/${glob}`, directoryNamePattern(glob, false)]),
);

/** Temporary directories, including hidden variants (`.tmp`, etc.). */
const tempIgnoreMatchers = compileMatchers(
  ["temp", "tmp", "temps", "scratch"]
    .flatMap((name) => [name, `.${name}`])
    .map((name) => directoryNamePattern(name)),
);

/** Test directories and common test-file naming conventions. */
const testIgnoreMatchers = compileMatchers([
  ...["test", "tests", "__tests__", "__snapshots__"]
    .flatMap((name) => [name, `.${name}`])
    .map((name) => directoryNamePattern(name)),
  "**/*.test.*",
  "**/*.spec.*",
  "**/test.*",
  "**/spec.*",
]);

/** Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, …). */
const lockIgnoreMatchers = compileMatchers([
  "**/bun.lockb",
  ...["json", "yaml", "yml"].map((ext) => `**/*-lock.${ext}`),
  ...["lock"].map((ext) => fileExtensionPattern(ext)),
]);

/**
 * Collects the pre-compiled matcher maps for each enabled built-in group.
 *
 * Group toggles come from `options`; the lock group also respects
 * {@link lockIgnoreMatchersEnabled} (`lock: "auto"` probes the npm registry).
 */
function ignoreMatchPredicates(
  options?: IgnorePatternOptions,
): Record<string, PathMatchPredicate>[] {
  const ignoreMatchRecords: Record<string, PathMatchPredicate>[] = [];
  if (options?.defaults ?? true) ignoreMatchRecords.push(defaultIgnoreMatchers);
  if (options?.temp ?? true) ignoreMatchRecords.push(tempIgnoreMatchers);
  if (options?.test ?? true) ignoreMatchRecords.push(testIgnoreMatchers);
  if (options?.dot ?? true) ignoreMatchRecords.push(dotIgnoreMatchers);
  if (lockIgnoreMatchersEnabled(options)) ignoreMatchRecords.push(lockIgnoreMatchers);
  return ignoreMatchRecords;
}

/**
 * Yields the glob strings for each enabled built-in ignore group.
 *
 * Useful when a consumer needs literal patterns (e.g. projen `.gitignore` /
 * `.prettierignore`) rather than a compiled {@link PathMatcher}.
 *
 * @param options - Group toggles; omitted flags default to enabled.
 */
export function ignorePatterns(options?: IgnorePatternOptions): Sequence<string> {
  return object.sequence(ignoreMatchPredicates(options)).flatMap(Object.keys).distinct();
}

/**
 * Returns a {@link PathMatcher} for paths ignored by the enabled built-in groups.
 *
 * Matchers for each group are compiled once at module load; `options` only
 * selects which groups participate. The lock group is included when
 * {@link lockIgnoreMatchersEnabled} returns `true`.
 *
 * @param options - Group toggles; omitted flags default to enabled.
 */
export function ignorePathMatcher(options?: IgnorePatternOptions): PathMatcher {
  const predicates = ignoreMatchPredicates(options).flatMap(Object.values);
  return toPathMatcher(...predicates);
}
