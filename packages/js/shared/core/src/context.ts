/**
 * The ambient CONTEXT a cached value belongs to, and a cache keyed by it.
 *
 * Most of the expensive lookups in this repo are pure functions of the directory
 * (or the page) they were asked from: `npm prefix`, `git rev-parse`, a `.env`
 * file, `databricks bundle validate`. Memoizing them with
 * {@link functionModule.memoize} is wrong in exactly one situation, and it is the
 * situation a CLI hits: the process changes directory, and the cached answer now
 * describes somewhere else. Every caller therefore grew the same guard - resolve
 * `cwd`, compare it against `process.cwd()`, and skip the cache when they differ
 * (see the `cacheEnabled` dance this module replaced in node-core's `project`).
 *
 * This is that guard, once. A cache slot stores the context it was loaded under,
 * so a context change (a moved `cwd`, a different origin) MISSES rather than
 * returns a stale value, and a lookup for some OTHER directory is not cached at
 * all - one off-context call must not evict or poison the hot path.
 *
 * The context is the process working directory on a server and
 * `location.origin` in a browser, whichever this runtime has. Browser-safe:
 * `process` and `location` are reached through `globalThis` and guarded, so this
 * module needs no Node types and simply has no context off-process.
 *
 * @example
 * const roots = context.cached(["project", "npm", "prefix"], (cwd) =>
 *   spawnSync("npm", ["prefix"], { cwd }),
 * );
 *
 * @module
 */

import type { OneOrMany } from "./object.ts";

/** A loader for a cached value; receives the resolved context. */
export type ContextLoader<T> = (context: string | undefined) => T;

interface CacheEntry {
  context: string;
  value: unknown;
}

const CACHE = new Map<string, CacheEntry>();

/**
 * The current context: the process working directory, else `location.origin`,
 * else `undefined` (a runtime with neither, where nothing is cacheable).
 */
export function getContext(): string | undefined {
  for (const context of getContexts()) return context;
  return undefined;
}

/**
 * Whether `value` names a context this runtime is CURRENTLY in - the live `cwd`
 * or origin. This is the cacheability test: a value loaded for some other
 * directory is correct but not shareable, so it is never stored.
 */
export function isContext(value: unknown): boolean {
  const context = toContext(value);
  if (context === undefined) return false;
  for (const candidate of getContexts()) {
    if (candidate === context) return true;
  }
  return false;
}

/**
 * Load `name` through `loader`, reusing the cached value while the context is
 * unchanged.
 *
 * `context` selects what the value is loaded FOR: omitted, `null`, or `"."` mean
 * the current context. It is passed straight to `loader`, so a loader never has
 * to reach for `process.cwd()` itself.
 *
 * Caching happens only when the resolved context is one this runtime is in
 * ({@link isContext}), so `cached(name, loader, "/somewhere/else")` always calls
 * `loader` and stores nothing. A stored entry remembers its context and is
 * discarded on the next call once that context changes. A thrown error is never
 * cached; a rejected promise evicts its entry so a later call retries.
 *
 * `name` identifies the slot and must be stable across calls - pass a
 * module-qualified list of string parts (`["project", command, ...args]`) so two
 * modules cannot collide on one slot.
 */
export function cached<T>(
  name: OneOrMany<string>,
  loader: ContextLoader<T>,
  context?: string | null,
): T {
  const resolved = toContext(context) ?? getContext();
  const key = resolved !== undefined && isContext(resolved) ? cacheKey(name) : undefined;
  if (key !== undefined) {
    const entry = CACHE.get(key);
    if (entry && entry.context === resolved) return entry.value as T;
  }
  const value = loader(resolved);
  if (key !== undefined && resolved !== undefined) {
    const entry: CacheEntry = { context: resolved, value };
    CACHE.set(key, entry);
    if (isThenable(value)) {
      void Promise.resolve(value).catch(() => {
        if (CACHE.get(key) === entry) CACHE.delete(key);
      });
    }
  }
  return value;
}

/** Drop one cached slot, or the whole cache when `name` is omitted. */
export function clear(name?: OneOrMany<string>): void {
  if (name === undefined) CACHE.clear();
  else CACHE.delete(cacheKey(name));
}

/**
 * Canonical slot key. `JSON.stringify` over the parts rather than a hash: the
 * parts are already strings, and an exact key cannot collide two unrelated
 * lookups onto one slot the way a truncated digest can.
 */
function cacheKey(name: OneOrMany<string>): string {
  return JSON.stringify(typeof name === "string" ? [name] : name);
}

/**
 * Every context this runtime reports, in precedence order. A server yields its
 * `cwd`; a browser yields `location.origin`. A hybrid (a worker with both) yields
 * both, which is what makes {@link isContext} accept either.
 */
function* getContexts(): Generator<string, void, void> {
  const global = globalThis as {
    process?: { cwd?: () => string };
    location?: { origin?: string };
  };
  const cwd = global.process?.cwd;
  if (typeof cwd === "function") {
    let current: unknown;
    try {
      current = cwd();
    } catch {
      current = undefined;
    }
    const context = toContext(current);
    if (context !== undefined) yield context;
  }
  const origin = toContext(global.location?.origin);
  if (origin !== undefined) yield origin;
}

/** A non-blank string, with `"."` treated as "the current context" (unresolved). */
function toContext(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "." ? trimmed : undefined;
}

/** Duck-type any value with a callable `.then` as a thenable. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value instanceof Promise ||
    (typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as PromiseLike<unknown>).then === "function")
  );
}
