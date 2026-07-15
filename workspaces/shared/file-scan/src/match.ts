/**
 * Path matching and predicate composition for file scanning and watching.
 *
 * {@link toPathMatcher} and {@link ignorePatternPredicate} compile globs into
 * composable predicates (`and`/`or`/`negate`). {@link toMatchFunction} wraps a
 * predicate for directory-pruning match functions shared by scanners and watchers.
 */

import { iterable } from "@dbx-tools/shared-core";
import { Minimatch } from "minimatch";
import { ignorePathMatcher } from "./ignore";

export type PathMatchPredicate = (path: string) => boolean;

/**
 * Anything {@link toPathMatcher} accepts: a glob string (compiled with
 * `dot: true`), a pre-built {@link Minimatch}, or a custom `(path) => boolean`.
 */
export type PathMatchInput = PathMatchPredicate | string;
/**
 * A path test (`true` == ignore) with combinators for composing further tests.
 * `and`/`or`/`negate` each return a new, independently composable predicate.
 */
export type PathMatcher = PathMatchPredicate & {
  and(...patterns: readonly (PathMatchInput | null | undefined)[]): PathMatcher;
  or(...patterns: readonly (PathMatchInput | null | undefined)[]): PathMatcher;
  negate(): PathMatcher;
};

/** Normalizes a {@link PatternInput} to a plain path test. */
function toTest(pattern: PathMatchInput): (path: string) => boolean {
  if (typeof pattern === "string") {
    const matcher = new Minimatch(pattern, { dot: true });
    return (path) => {
      const result = matcher.match(path);
      return result;
    };
  } else {
    return pattern;
  }
}

/** Wraps a path test with the `and`/`or`/`negate` combinators. */
function withCombinators(test: (path: string) => boolean): PathMatcher {
  return Object.assign(test, {
    and(...patterns: readonly (PathMatchInput | null | undefined)[]): PathMatcher {
      const other = toPathMatcher(...patterns);
      return withCombinators((path) => test(path) && other(path));
    },
    or(...patterns: readonly (PathMatchInput | null | undefined)[]): PathMatcher {
      const other = toPathMatcher(...patterns);
      return withCombinators((path) => test(path) || other(path));
    },
    negate(): PathMatcher {
      return withCombinators((path) => !test(path));
    },
  });
}

/**
 * Combines one or more patterns into a single {@link PathMatcher} (OR'd).
 * Strings are compiled with `dot: true`; matchers and predicates are used as-is;
 * `null`/`undefined` entries are skipped. With no matching patterns the result
 * always returns `false`.
 *
 * @param patterns - Globs, matchers, and/or predicates to OR together.
 */
export function toPathMatcher(
  ...inputs: readonly (PathMatchInput | null | undefined)[]
): PathMatcher {
  const tests = iterable.sequence(inputs).nonNull().map(toTest).cache();
  return withCombinators((path) => tests.some((test) => test(path)));
}

if (import.meta.main) {
  const matcher = ignorePathMatcher({ test: true }).negate().and("**/cool.ts", "**/wow.ts");
  console.log(matcher("workspaces/shared/file-scan/src/cool.ts"));
  console.log(matcher("workspaces/shared/file-scan/.src/cool.ts"));
}
