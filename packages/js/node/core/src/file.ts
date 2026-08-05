/**
 * Filesystem utilities: best-effort `fs.stat` helpers that never throw.
 *
 * @module
 */
import { Stats, statSync as nodeStatSync } from "node:fs";

const recordCache = new Map<string, Record<string, unknown> | undefined>();

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
