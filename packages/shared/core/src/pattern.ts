/**
 * Literal / glob / regex string matching, compiled to a composable
 * {@link Predicate}.
 *
 * A configurable allow-list is the same shape everywhere in this repo: a list of
 * patterns from a config field or an env var, where an operator reasonably
 * expects to write a plain value, a `*` wildcard, or - when neither is enough -
 * a real regex. Each consumer used to grow its own `globToRegExp` +
 * `/pattern/flags` parser; this is that parser, once.
 *
 * Three shapes are recognized per entry, tried in order:
 *
 * - **regex** - wrapped in slashes (`/^x-mastra-/`, with optional trailing
 *   flags). Compiled as written. An invalid regex never matches: it is skipped
 *   with a warning rather than throwing, so one bad entry cannot take a process
 *   down at startup.
 * - **glob** - contains `*` or `?` (`x-mastra-*`). Shell-style, anchored at both
 *   ends: `*` matches any run of characters, `?` exactly one.
 * - **literal** - anything else. Whole-string equality.
 *
 * Matching is case-INSENSITIVE by default, which is what the callers want (HTTP
 * header names and email addresses are both case-insensitive); pass
 * `caseSensitive` to opt out. An empty pattern list matches NOTHING, so a
 * caller that treats "no patterns" as "permit everything" must special-case it
 * rather than relying on the matcher.
 *
 * Browser-safe: hand-compiled to `RegExp` with no glob dependency, so this stays
 * usable from a client bundle. Node code that needs path-aware globbing
 * (`/` as a segment boundary, `**`) wants `@dbx-tools/path`'s `toPathMatcher`
 * instead - that one is `minimatch`-backed and understands path semantics.
 *
 * @example
 * const allowed = toPatternMatcher(["x-mastra-*", "/^x-trace-/"]);
 * allowed("x-mastra-thread-id"); // true
 * allowed("x-forwarded-user");   // false
 *
 * @module
 */

import { logger } from "./log.ts";
import * as predicate from "./predicate.ts";
import { parseList } from "./string.ts";

const log = logger("shared/pattern");

/** Options for {@link toPattern} / {@link toPatternMatcher}. */
export interface PatternOptions {
  /** Match case-sensitively. Default `false` (case-insensitive). */
  caseSensitive?: boolean;
}

/** Escape a string for literal use inside a `RegExp`. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `pattern` is a `/.../flags` regex literal. */
function isRegexLiteral(pattern: string): boolean {
  return pattern.length > 1 && pattern.startsWith("/") && /\/[a-z]*$/i.test(pattern);
}

/** True when `pattern` contains a glob wildcard. */
function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/**
 * Compile a `/pattern/flags` literal, or `undefined` when it is malformed or
 * the body is not a valid regex.
 */
function compileRegexLiteral(pattern: string, caseSensitive: boolean): RegExp | undefined {
  const parsed = /^\/(.+)\/([a-z]*)$/is.exec(pattern);
  if (!parsed) return undefined;
  const body = parsed[1]!;
  const flags = parsed[2]!;
  try {
    return new RegExp(body, caseSensitive || flags.includes("i") ? flags : `${flags}i`);
  } catch (error) {
    log.warn("ignoring invalid regex pattern", { pattern, error });
    return undefined;
  }
}

/**
 * Compile a shell-style glob (`*`, `?`) into an anchored `RegExp`. Every other
 * character is escaped, so a glob can safely contain regex metacharacters
 * (`x-app.*` matches a literal dot followed by anything).
 */
function compileGlob(pattern: string, caseSensitive: boolean): RegExp {
  const body = pattern
    .split(/([*?])/)
    .map((part) => (part === "*" ? ".*" : part === "?" ? "." : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${body}$`, caseSensitive ? "" : "i");
}

/**
 * Compile ONE pattern into a predicate, or `undefined` when the entry is empty
 * or an unparseable regex literal.
 *
 * Callers that want a whole list should use {@link toPatternMatcher}; this is
 * exported for the case where a consumer applies its own semantics to some
 * shapes and only wants the glob/regex handling (the email gate's bare-domain
 * shortcut, for one).
 */
export function toPattern(
  pattern: string,
  options: PatternOptions = {},
): predicate.Predicate<string> | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  const caseSensitive = options.caseSensitive ?? false;

  if (isRegexLiteral(trimmed)) {
    const compiled = compileRegexLiteral(trimmed, caseSensitive);
    return compiled && predicate.create<string>((value) => compiled.test(value));
  }
  if (isGlob(trimmed)) {
    const compiled = compileGlob(trimmed, caseSensitive);
    return predicate.create<string>((value) => compiled.test(value));
  }
  // Literal: whole-string equality.
  const expected = caseSensitive ? trimmed : trimmed.toLowerCase();
  return predicate.create<string>((value) =>
    caseSensitive ? value === expected : value.toLowerCase() === expected,
  );
}

/**
 * Compile patterns into a single OR'd {@link Predicate}. Accepts the raw config
 * shapes {@link parseList} does - an array, or one comma/whitespace-separated
 * string - so a field and its env var need no separate handling.
 *
 * With no usable patterns the result always returns `false`.
 *
 * @example
 * const forwardable = toPatternMatcher(process.env.TUNNEL_FORWARD_HEADERS);
 */
export function toPatternMatcher(
  patterns: string | readonly string[] | undefined | null,
  options: PatternOptions = {},
): predicate.Predicate<string> {
  const compiled = parseList(patterns)
    .map((pattern) => toPattern(pattern, options))
    .filter((value): value is predicate.Predicate<string> => value !== undefined);
  if (compiled.length === 0) return predicate.create<string>(() => false);
  return compiled.slice(1).reduce((acc, next) => acc.or(next), compiled[0]!);
}
