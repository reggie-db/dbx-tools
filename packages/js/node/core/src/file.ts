/**
 * Host filesystem utilities: lexical path containment, best-effort `fs.stat`,
 * and parsed-record caching.
 *
 * @module
 */
import { Stats, statSync as nodeStatSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const recordCache = new Map<string, Record<string, unknown> | undefined>();

/**
 * Return the host-relative path when `candidate` is `root` or a descendant,
 * otherwise `undefined`. Equality returns `""`; callers requiring a strict
 * descendant can reject that empty result.
 *
 * Uses native host path resolution, including `.` / `..` normalization and
 * Windows drive boundaries. A name beginning with `..` is not an escape unless
 * that entire path segment is `..`.
 *
 * This is a lexical check, not a symlink boundary. Resolve real paths first when
 * containment must account for symlinks.
 */
export function relativePathWithin(root: string, candidate: string): string | undefined {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path;
}

/**
 * Best-effort `fs.stat` (sync). Returns `undefined` for a blank path or when the
 * path can't be stat'd (missing, permission denied, ...), so callers can treat
 * "not there" and "not accessible" the same and never handle an exception.
 */
export function statSync(path: string): Stats | undefined {
  if (path) {
    try {
      return nodeStatSync(path);
    } catch {}
  }
  return undefined;
}

/**
 * Load and cache a parsed record by caller-defined source identity.
 *
 * Every result is cached, including empty records and `undefined`. Include every
 * input that affects parsing in `key`, such as a file path plus a Databricks
 * profile.
 */
export function cachedRecord<T extends Record<string, unknown>>(
  key: string,
  loader: () => T | undefined,
): T | undefined {
  if (recordCache.has(key)) return recordCache.get(key) as T | undefined;
  const value = loader();
  recordCache.set(key, value);
  return value;
}
