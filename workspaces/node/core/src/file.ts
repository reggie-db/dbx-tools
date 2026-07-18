/**
 * Filesystem utilities: best-effort `fs.stat` helpers that never throw.
 *
 * @module
 */
import { Stats, statSync as nodeStatSync } from "node:fs";

/**
 * Best-effort `fs.stat` (sync). Returns `undefined` for a blank path or when the
 * path can't be stat'd (missing, permission denied, ...), so callers can treat
 * "not there" and "not accessible" the same and never handle an exception.
 */
export function statSync(path: string): Stats | undefined {
  if (path) {
    try {
      return nodeStatSync(path);
    } catch { }
  }
  return undefined;
}
