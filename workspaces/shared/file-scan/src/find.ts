import { iterable } from "@dbx-tools/shared-core";
import { globIterateSync, IgnoreLike, type GlobOptionsWithFileTypesUnset } from "glob";
import { ignorePathMatcher } from "./ignore";
import { PathMatcher, PathMatchInput, pathMatchTests, toPathMatcher } from "./match";
import { FileScanIgnoreOptions, FileScanOptions, FOLLOW_SYMLINKS_DEFAULT } from "./scan";

type FileFindIgnore = PathMatchInput | readonly PathMatchInput[] | IgnoreLike;

export interface FileFindOptions
  extends
    Omit<
      GlobOptionsWithFileTypesUnset,
      "ignore" | "follow" | "dot" | "cwd" | "includeChildMatches"
    >,
    Omit<FileScanOptions, "ignore" | "cwd"> {
  cwd?: string | URL;
  ignore?: FileFindIgnore;
}
/**
 * Recursively lists files matching `pattern`, ignoring the shared default groups
 * plus any caller `ignore` patterns (unless `ignore` is a lone predicate function,
 * in which case only that predicate applies). The ignore list mirrors what
 * {@link watchFiles} feeds through its matchers.
 */
export function findFiles(
  pattern: string | string[],
  options?: FileFindOptions,
): iterable.Sequence<string> {
  return iterable.sequence(globIterateSync(pattern, toGlobOptions(options)));
}

function toGlobOptions(options: FileFindOptions | undefined): GlobOptionsWithFileTypesUnset {
  const { cwd, ignore, ignoreOptions, followSymlinks, ...restOptions } = options ?? {};
  return {
    ...restOptions,
    cwd: cwd ?? process.cwd(),
    follow: followSymlinks ?? FOLLOW_SYMLINKS_DEFAULT,
    ignore: normalizeIgnore(ignore, ignoreOptions),
  };
}

const IGNORE_LIKE_FIELDS = [
  "ignored",
  "childrenIgnored",
  "add",
] as const satisfies readonly (keyof IgnoreLike)[];

function isIgnoreLike(value: unknown): value is IgnoreLike {
  if (Array.isArray(value)) return false;
  if (typeof value === "object" && value !== null) {
    for (const field of IGNORE_LIKE_FIELDS) {
      if (field in value && typeof (value as any)[field] !== "function") {
        return false;
      }
    }
    return true;
  }
  return false;
}
/**
 * Builds the {@link IgnoreLike} object {@link findFiles} hands to `glob`.
 *
 * A caller-supplied `IgnoreLike` (an object, not string/array) is consulted
 * first - its `ignored`/`childrenIgnored` win - after which the shared
 * {@link ignorePathMatcher} (the same matcher {@link watchFiles} uses) decides based on the
 * package-relative path. `cacheDirectoryStats` is enabled because glob probes
 * many paths per directory. Caller string/array patterns are merged into the
 * matcher, and `add` forwards to both the caller object and the matcher.
 */
function normalizeIgnore(
  ignore: FileFindIgnore | undefined,
  ignoreOptions: FileScanIgnoreOptions | undefined,
): IgnoreLike {
  const ignoreLike: IgnoreLike | undefined = isIgnoreLike(ignore) ? ignore : undefined;
  const ignorePathMatcherInputs: PathMatchInput[] | undefined =
    ignore === undefined || ignoreLike ? undefined : Array.isArray(ignore) ? [...ignore] : [ignore];

  const predicateOnly =
    ignorePathMatcherInputs?.length === 1 && typeof ignorePathMatcherInputs[0] === "function";

  let ignoreMatcher: PathMatcher = predicateOnly
    ? toPathMatcher(ignorePathMatcherInputs[0])
    : ignorePathMatcher(ignoreOptions);
  if (ignorePathMatcherInputs && !predicateOnly) {
    ignoreMatcher = ignoreMatcher.or(...pathMatchTests(...ignorePathMatcherInputs));
  }
  return {
    ignored(path) {
      if (ignoreLike?.ignored?.(path)) return true;
      const patheRelative = path.relative();
      const ignore = ignoreMatcher(patheRelative);
      return ignore;
    },
    childrenIgnored(path) {
      if (ignoreLike?.childrenIgnored?.(path)) return true;
      const patheRelative = path.relative();
      if (patheRelative) {
        if (ignoreMatcher(patheRelative)) {
          return true;
        } else if (ignoreMatcher(patheRelative + "/")) {
          return true;
        }
      }
      return false;
    },
    add(ignore) {
      ignoreLike?.add?.(ignore);
      ignoreMatcher = ignoreMatcher.and(...pathMatchTests(ignore));
    },
  };
}

// Manual demo: run this file directly (e.g. `tsx src/find.ts`) to print the
// files findFiles keeps for this package under the given ignore options.
if (import.meta.main) {
  const startTime = performance.now();
  const cwd = process.cwd();
  console.log(`Scanning: ${cwd}`);

  const files = findFiles("**/*.*", {
    ignore: ["**/index.ts", "**/example/**", "**/*.md"],
    ignoreOptions: {
      test: true,
    },
  });
  for (const file of files) {
    console.log(file);
  }
  const elapsed = performance.now() - startTime;
  console.log(`Elapsed: ${elapsed}ms`);
}
