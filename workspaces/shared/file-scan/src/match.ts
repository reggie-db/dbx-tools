/**
 * Path matching and predicate composition for file scanning and watching.
 *
 * {@link toPathMatcher} compiles globs into {@link predicate.Predicate} values from
 * shared-core (`and` / `or` / `negate`) for use by {@link findFiles} and
 * {@link watchFiles}.
 */

import { iterable, predicate } from "@dbx-tools/shared-core";
import { Minimatch } from "minimatch";
import { ignorePathMatcher } from "./ignore";

export type PathMatchPredicate = predicate.PredicateFunction<string>;

/** A composable path test (`true` == match). */
export type PathMatcher = predicate.Predicate<string>;

/**
 * Anything {@link toPathMatcher} accepts: a glob string (compiled with
 * `dot: true`), or a custom `(path) => boolean`.
 */
export type PathMatchInput = PathMatchPredicate | string;

/** Normalizes a {@link PathMatchInput} to a plain path test. */
function toTest(pattern: PathMatchInput): PathMatchPredicate {
  if (typeof pattern === "string") {
    const matcher = new Minimatch(pattern, { dot: true });
    return (path) => matcher.match(path);
  }
  return pattern;
}

/** Compiles path match inputs to predicate functions for `.and()` / `.or()`. */
export function pathMatchTests(
  ...inputs: readonly (PathMatchInput | null | undefined)[]
): readonly PathMatchPredicate[] {
  return iterable.sequence(inputs).nonNull().map(toTest).toArray();
}

/**
 * Combines one or more patterns into a single {@link PathMatcher} (OR'd).
 * Strings are compiled with `dot: true`; predicates are used as-is;
 * `null`/`undefined` entries are skipped. With no matching patterns the result
 * always returns `false`.
 *
 * @param patterns - Globs and/or predicates to OR together.
 */
export function toPathMatcher(
  ...inputs: readonly (PathMatchInput | null | undefined)[]
): PathMatcher {
  const tests = pathMatchTests(...inputs);
  if (tests.length === 0) return predicate.create(() => false);
  return tests
    .slice(1)
    .reduce<PathMatcher>((acc, test) => acc.or(test), predicate.create(tests[0]!));
}

if (import.meta.main) {
  const matcher = ignorePathMatcher({ test: true })
    .negate()
    .and(...pathMatchTests("**/cool.ts", "**/wow.ts"));
  console.log(matcher("workspaces/shared/file-scan/src/cool.ts"));
  console.log(matcher("workspaces/shared/file-scan/.src/cool.ts"));
}
