/**
 * URL allow-list policy for the web-search add-on.
 *
 * A configured allow-list restricts which URLs the tools will surface or
 * fetch. Each entry is a glob compiled by `@dbx-tools/path`'s
 * {@link match.toPathMatcher} (the same `Minimatch`-backed matcher the
 * package's file scanning uses). Because that matcher treats `/` as a
 * path-segment boundary, entries are matched against the right slice of the
 * URL rather than the raw `href`:
 *
 * - A **host** entry (no `/` after the optional scheme, e.g. `databricks.com`
 *   or `*.databricks.com`) is tested against the URL's `hostname`. A bare
 *   host with no wildcard also matches its subdomains, so `databricks.com`
 *   permits `docs.databricks.com` - the intuitive reading of a domain
 *   allow-list.
 * - A **path** entry (contains a `/`, e.g. `docs.example.com/api/**`) is
 *   tested against `host + pathname` (scheme and query stripped), so path
 *   globs work without fighting the `https://` prefix.
 *
 * Enforcement is asymmetric by design (see the module's two consumers):
 * `web_search` results are SILENTLY filtered to the permitted set, while an
 * explicit `web_fetch` of a disallowed URL is refused with an error - the
 * search never leaks a URL the caller then can't fetch, but a direct fetch
 * of a blocked URL is a visible, correctable mistake rather than a silent
 * empty.
 *
 * An empty / absent allow-list permits everything.
 *
 * @module
 */

import { object } from "@dbx-tools/shared-core";
import { match, type PathMatcher } from "@dbx-tools/path";

/** A compiled URL allow-list. Build one with {@link toUrlAllowList}. */
export interface UrlAllowList {
  /** The normalized entries backing this list (for diagnostics). */
  readonly patterns: readonly string[];
  /** Whether the list actually restricts anything (`false` == permit all). */
  readonly restricted: boolean;
  /** Whether `url` is permitted. An unrestricted list permits everything. */
  allows(url: string): boolean;
}

/** Strip a leading `scheme://` (or bare `scheme:`) from a pattern. */
function stripScheme(pattern: string): string {
  return pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[a-z][a-z0-9+.-]*:/i, "");
}

/**
 * Normalize one raw allow-list entry: trim it and drop any scheme. The
 * scheme is irrelevant to matching (we compare against hostname / host+path),
 * so `https://docs.example.com/x` and `docs.example.com/x` are equivalent.
 */
export function normalizeUrlPattern(pattern: string): string {
  return stripScheme(pattern.trim());
}

/**
 * Parse a raw allow-list from config (`string[]`) or an env var (a CSV /
 * whitespace-separated string) into a normalized, de-duplicated entry list.
 * Entries are trimmed and scheme-stripped; empties are dropped. Mirrors the
 * email add-on's `parseAllowedSenders` so the two policies read their config
 * identically.
 */
export function parseAllowedUrls(raw: string | string[] | undefined): string[] {
  const entries = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];
  return [
    ...object
      .sequence(entries)
      .map((entry) => normalizeUrlPattern(entry))
      .filter((entry) => entry.length > 0)
      .distinct()
      .toArray(),
  ];
}

/** One compiled entry: which URL slice it tests, and the matcher for it. */
interface CompiledPattern {
  target: "hostname" | "hostPath";
  matcher: PathMatcher;
}

/** Compile a single normalized entry into a {@link CompiledPattern}. */
function compilePattern(pattern: string): CompiledPattern {
  if (pattern.includes("/")) {
    // A path entry matches against `host + pathname` (no scheme, no query).
    return { target: "hostPath", matcher: match.toPathMatcher(pattern) };
  }
  // A host entry matches the hostname. A bare host (no wildcard) also
  // permits its subdomains via an added `*.<host>` alternative.
  const globs = pattern.includes("*") ? [pattern] : [pattern, `*.${pattern}`];
  return { target: "hostname", matcher: match.toPathMatcher(...globs) };
}

/** The URL slices a compiled pattern is tested against. */
function urlTargets(url: string): { hostname: string; hostPath: string } | undefined {
  try {
    const u = new URL(url);
    return {
      hostname: u.hostname,
      // Drop a trailing slash so `example.com/api` matches `example.com/api/`.
      hostPath: `${u.hostname}${u.pathname}`.replace(/\/$/, ""),
    };
  } catch {
    return undefined;
  }
}

/**
 * Compile a normalized entry list into a {@link UrlAllowList}. An empty list
 * yields a permit-all allow-list whose {@link UrlAllowList.allows} always
 * returns `true`. A URL that can't be parsed is never permitted by a
 * restricted list.
 */
export function toUrlAllowList(patterns: readonly string[]): UrlAllowList {
  if (patterns.length === 0) {
    return { patterns: [], restricted: false, allows: () => true };
  }
  const compiled = patterns.map(compilePattern);
  return {
    patterns,
    restricted: true,
    allows: (url: string) => {
      const targets = urlTargets(url);
      if (!targets) return false;
      return compiled.some((c) => c.matcher(targets[c.target]));
    },
  };
}

/**
 * Throw when `url` is not permitted by the allow-list. No-op when the
 * allow-list is unrestricted. The single enforcement point for the
 * `web_fetch` path.
 */
export function assertUrlAllowed(url: string, allow: UrlAllowList): void {
  if (!allow.allows(url)) {
    throw new Error(
      `web-search: URL "${url}" is not permitted by the configured allow-list (${allow.patterns.join(", ")})`,
    );
  }
}
