/**
 * Built-in ignore glob patterns for file scanning and watching.
 *
 * {@link ignorePatterns} yields the enabled glob strings for each built-in group.
 * Matching and predicate composition live in {@link ./match}.
 */

import { Sequence, sequence } from "@dbx-tools/shared-core";
import { directoryNamePattern, fileExtensionPattern } from "./pattern";
import { PathMatcher, PathMatchPredicate, toPathMatcher } from "./match";

/** Toggles for each built-in ignore group; omitted flags default to `true`. */
export type IgnorePatternOptions = {
  /** Build artifacts, dependency dirs, caches, logs, lock files, OS files. */
  defaults?: boolean;
  /** Temporary directories (`tmp`, `.tmp`, `scratch`, etc.). */
  temp?: boolean;
  /** Test directories and `*.test.*` / `*.spec.*` naming conventions. */
  test?: boolean;
  /** Hidden dot-directories (`.git`, `.vscode`, `.idea`, etc.). */
  dot?: boolean;
};

/** 
 * Compiles glob strings into `{ [glob]: Minimatch }`, each with `dot: true`.
 * Keying by the source glob de-dupes and keeps each matcher beside its pattern.
 */
function compileMatchers(patterns: readonly string[]): Record<string, PathMatchPredicate> {
  return Object.fromEntries(patterns.map((glob) => [glob, toPathMatcher(glob)]));
}

/** Build artifacts, dependency directories, caches, logs, lock files, and OS files. */
const defaultIgnoreMatchers = compileMatchers([
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/Desktop.ini",
  ...["log", "tsbuildinfo", "lock", "lockb", "lock.json", "lock.yaml"].map((ext) => fileExtensionPattern(ext)),
  "**/npm-debug.log*",
  "**/yarn-debug.log*",
  "**/yarn-error.log*",
  "**/pnpm-debug.log*",
  ...[
    "node_modules",
    "bower_components",
    "jspm_packages",
    "dist",
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

/** Hidden dot-directories such as `.git`, `.vscode`, `.idea`, etc. */
const dotIgnoreMatchers = compileMatchers(
  [".*"].flatMap((glob) => [`**/${glob}`, directoryNamePattern(glob, false)]),
);



/** Collects the pre-compiled {@link Minimatch} instances for enabled built-in groups. */
function ignoreMatchPredicates(options?: IgnorePatternOptions): (Record<string, PathMatchPredicate>)[] {
  const ignoreMatchRecords: (Record<string, PathMatchPredicate>)[] = [];
  if (options?.defaults ?? true) ignoreMatchRecords.push(defaultIgnoreMatchers);
  if (options?.temp ?? true) ignoreMatchRecords.push(tempIgnoreMatchers);
  if (options?.test ?? true) ignoreMatchRecords.push(testIgnoreMatchers);
  if (options?.dot ?? true) ignoreMatchRecords.push(dotIgnoreMatchers);
  return ignoreMatchRecords;
}

/**
 * Yields the glob strings for each enabled built-in ignore group.
 *
 * @param options - Group toggles; omitted flags default to enabled.
 */
export function ignorePatterns(options?: IgnorePatternOptions): Sequence<string> {
  return sequence(ignoreMatchPredicates(options)).flatMap(Object.keys).distinct();
}


/**
 * Returns a predicate matching paths ignored by the enabled built-in groups.
 * Matchers for the full built-in set are compiled once at load; group toggles
 * compile only the selected groups.
 *
 * @param options - Group toggles; omitted flags default to enabled.
 */
export function ignorePathMatcher(options?: IgnorePatternOptions): PathMatcher {
  const predicates = ignoreMatchPredicates(options).flatMap(Object.values);
  return toPathMatcher(...predicates);
}