/**
 * Shared ignore-pattern building blocks for file scanning and watching.
 *
 * Exposes the built-in ignore groups (build artifacts, dotfiles, temp and test
 * dirs), {@link ignorePatterns} to assemble them with caller patterns, and
 * {@link Matcher} / {@link ignoreMatcher} - a lazily-compiled glob matcher that
 * both `fileScan` and `fileWatch` share, so identical patterns produce identical
 * ignore decisions across the two.
 */
import { statSync } from "fs";
import { generator } from "@dbx-tools/shared-core";
import { Minimatch } from "minimatch";

/** Characters that are special in a glob; escaped so a name is matched literally. */
const ESCAPE_GLOB_REGEXP = /([*?[\]{}()!+@\\])/g;

/** Common build artifacts, dependency directories, caches, logs, lock files, and OS files ignored by default. */
const DEFAULT_IGNORE_PATTERNS = [
  // OS files
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/Desktop.ini",

  // Logs, lock files, and build metadata
  ...["log", "tsbuildinfo", "lock", "lockb", "lock.json", "lock.yaml"].map((p) =>
    fileExtensionPattern(p),
  ),
  "**/npm-debug.log*",
  "**/yarn-debug.log*",
  "**/yarn-error.log*",
  "**/pnpm-debug.log*",

  ...[
    // Dependency directories
    "node_modules",
    "bower_components",
    "jspm_packages",
    // Build outputs
    "dist",
    "build",
    "out",
    "coverage",
    // Tool and framework caches
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".pnpm-store",
    ".nyc_output",
  ].map((p) => directoryNamePattern(p)),
] as const;

/** Common temporary directories, including hidden variants. */
const TEMP_IGNORE_PATTERNS = [
  ...["temp", "tmp", "temps", "scratch"]
    .flatMap((p) => [p, `.${p}`])
    .map((p) => directoryNamePattern(p)),
] as const;

/** Common test directories and test file naming conventions. */
const TEST_IGNORE_PATTERNS = [
  ...["test", "tests", "__tests__", "__snapshots__"]
    .flatMap((p) => [p, `.${p}`])
    .map((p) => directoryNamePattern(p)),
  "**/*.test.*",
  "**/*.spec.*",
  "**/test.*",
  "**/spec.*",
] as const;

/** Hidden directories such as `.git`, `.vscode`, `.idea`, etc. */
const DOT_IGNORE_PATTERNS = [
  ...[".*"].flatMap((p) => [`**/${p}`, directoryNamePattern(p, false)]),
] as const;

/** Options controlling the generated ignore pattern list. */
export type IgnorePatternsOptions = {
  /** Remove duplicate patterns.  Default `true`.  */
  distinct?: boolean;
  /** Sort the resulting patterns lexicographically.  Default `false`. */
  sort?: boolean;
  /** Include {@link DEFAULT_IGNORE_PATTERNS}. Default `true`. */
  defaultPatterns?: boolean;
  /** Include {@link TEMP_IGNORE_PATTERNS}. Default `true`. */
  tempPatterns?: boolean;
  /** Include {@link TEST_IGNORE_PATTERNS}. Default `true`. */
  testPatterns?: boolean;
  /** Include {@link DOT_IGNORE_PATTERNS}. Default `true`. */
  dotPatterns?: boolean;
};

/** Options for {@link ignoreMatcher}: the pattern-group toggles plus matcher tuning. */
export type IgnoreMatcherOptions = IgnorePatternsOptions & {
  /**
   * Memoize `statSync` directory checks used by the child-pruning branch of
   * {@link Matcher.match}. Worth enabling for glob, which probes each path often.
   */
  cacheDirectoryStats?: boolean;
};

/**
 * A reusable glob matcher over a set of ignore patterns, shared by
 * {@link fileScan} and {@link fileWatch} so the same patterns yield the same
 * decisions. Patterns compile to {@link Minimatch} lazily and are memoized, all
 * with `dot: true` so dotfiles match. Beyond a direct hit, {@link match} can also
 * report whether a directory's descendants are ignored (the pruning case).
 */
export class Matcher {
  /** Compiled matchers, memoized by their pattern string. */
  private readonly miniMatchers: Record<string, Minimatch> = {};
  /** Optional `path -> isDirectory` cache, avoiding repeat `statSync` calls. */
  private readonly directoryStatCache: Record<string, boolean> | undefined;
  /** Patterns not yet compiled into {@link miniMatchers} (consumed lazily). */
  private patterns: Generator<string>;

  /**
   * @param patterns - Ignore patterns to match against (compiled on first use).
   * @param cacheDirectoryStats - When `true`, memoize the `statSync` directory
   * checks performed by {@link match}'s child-pruning branch.
   */
  constructor(patterns: Iterable<string>, cacheDirectoryStats?: boolean) {
    this.patterns = generator(patterns);
    this.directoryStatCache = cacheDirectoryStats ? {} : undefined;
  }

  /**
   * Tests `path` against every pattern.
   *
   * Returns `true` on the first direct match. Otherwise, when `directory` is
   * truthy, it also tests the "children" case (a synthetic child path) so a
   * directory whose descendants are all ignored (e.g. a dependency folder) can be
   * pruned. With `directory: "stat"` the directory-ness is resolved lazily via
   * `statSync` (cached when enabled) and a non-directory short-circuits to `false`.
   *
   * @param path - Path to test.
   * @param directory - Whether `path` is a directory: a boolean, or `"stat"` to
   * detect it on demand only if the child-pruning branch is reached.
   * @returns `true` if `path` (or, for a directory, its children) is ignored.
   */
  match(path: string, directory?: boolean | "stat"): boolean {
    for (const matcher of this.matchers()) {
      if (matcher.match(path)) {
        return true;
      }
    }
    if (directory !== undefined && directory !== false) {
      const child = `${path}/\0`;
      for (const matcher of this.matchers()) {
        if (matcher.match(child)) {
          if (directory === "stat") {
            directory = this.directoryStatCache?.[path];
            if (directory === undefined) {
              try {
                directory = statSync(path).isDirectory();
              } catch {
                directory = false;
              }
              if (this.directoryStatCache !== undefined) {
                this.directoryStatCache[path] = directory;
              }
              if (!directory) return false;
            }
          }
          return true;
        }
      }
    }
    return false;
  }

  addPattern(pattern: string) {
    this.patterns = generator(this.patterns, pattern);
  }

  private *matchers(): Generator<Minimatch> {
    for (const matcher of Object.values(this.miniMatchers)) {
      yield matcher;
    }
    for (const pattern of this.patterns) {
      if (!(pattern in this.miniMatchers)) {
        const matcher = new Minimatch(pattern, { dot: true });
        this.miniMatchers[pattern] = matcher;
        yield matcher;
      }
    }
  }
}

/**
 * Builds a list of glob ignore patterns.
 *
 * Caller-supplied patterns are optionally combined with built-in groups for
 * common build artifacts, hidden directories, temporary directories, and test
 * files. Duplicate removal and sorting are controlled by
 * {@link IgnorePatternsOptions}.
 */
export function ignorePatterns(...patterns: string[]): string[];
export function ignorePatterns(
  options?: IgnorePatternsOptions | null,
  ...patterns: string[]
): string[];
export function ignorePatterns(
  ...args: [...patterns: string[]] | [options?: IgnorePatternsOptions | null, ...patterns: string[]]
): string[] {
  let { options, patterns } = ignoreArgs(args);
  const callerPatternsEmpty = patterns.length === 0;
  const {
    distinct = false,
    sort = false,
    defaultPatterns = true,
    dotPatterns = true,
    tempPatterns: temp = true,
    testPatterns: test = true,
  } = options ?? {};
  if (dotPatterns) patterns.push(...DOT_IGNORE_PATTERNS);
  if (defaultPatterns) patterns.push(...DEFAULT_IGNORE_PATTERNS);
  if (temp) patterns.push(...TEMP_IGNORE_PATTERNS);
  if (test) patterns.push(...TEST_IGNORE_PATTERNS);
  if (patterns.length > 0) {
    patterns = !callerPatternsEmpty && distinct ? [...new Set(patterns)] : patterns;
    if (sort) patterns.sort();
  }
  return patterns;
}

/**
 * Builds a {@link Matcher} from {@link ignorePatterns} - the caller patterns
 * combined with the enabled built-in groups. Accepts the same
 * `(options?, ...patterns)` or `(...patterns)` forms as {@link ignorePatterns},
 * with `cacheDirectoryStats` available via {@link IgnoreMatcherOptions}.
 */
export function ignoreMatcher(...patterns: string[]): Matcher;
export function ignoreMatcher(
  options?: IgnoreMatcherOptions | null,
  ...patterns: string[]
): Matcher;
export function ignoreMatcher(
  ...args: [...patterns: string[]] | [options?: IgnoreMatcherOptions | null, ...patterns: string[]]
): Matcher {
  let { options, patterns } = ignoreArgs(args);
  patterns = ignorePatterns(options, ...patterns);
  return new Matcher(patterns, options?.cacheDirectoryStats);
}

/**
 * Splits the overloaded `(options?, ...patterns)` / `(...patterns)` arguments
 * into an optional leading options object and the trailing pattern strings. A
 * leading string means options were omitted.
 */
function ignoreArgs<T extends IgnoreMatcherOptions>(
  args: [...patterns: string[]] | [options?: T | null, ...patterns: string[]],
): { options?: T | null; patterns: string[] } {
  let options: T | null | undefined;
  let patterns: string[];
  if (args.length > 0 && typeof args[0] !== "string") {
    options = args[0];
    patterns = args.slice(1) as string[];
  } else {
    patterns = args as string[];
  }
  return { options, patterns };
}

/**
 * Returns a glob matching all descendants of directories named `name`.
 *
 * By default, glob metacharacters in `name` are escaped so it is treated
 * literally. Pass `false` for `escape` when `name` intentionally contains
 * glob syntax.
 */
function directoryNamePattern(name: string, escape: boolean = true): string {
  return `**/${escape ? name.replace(ESCAPE_GLOB_REGEXP, "\\$1") : name}/**`;
}

function fileExtensionPattern(extension: string, escape = true): string {
  if (extension.startsWith(".")) {
    extension = extension.slice(1);
  }
  return `**/*.${escape ? extension.replace(ESCAPE_GLOB_REGEXP, "\\$1") : extension}`;
}
