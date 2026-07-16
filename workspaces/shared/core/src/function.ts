export interface MemoizeOptions {
  /**
   * Time-to-live in milliseconds. The cached value expires `ttlMs` after
   * it was stored, so the next call past that recomputes; a rejection is
   * also evicted so a later call retries rather than replaying the error.
   * Omitted or `<= 0` means a successful value is cached forever (the default).
   * Errors are never cached - see {@link memoize}.
   *
   * Use for periodically-refreshed data (published IP ranges, feature
   * flags, anything fetched once and reused across requests).
   */
  ttlMs?: number;
}

/**
 * Run a zero-argument factory once; later calls return the same result.
 * The memoized function mirrors the factory's sync / async nature: a
 * sync factory yields a sync getter (`() => T`), an async / thenable
 * factory yields a promise-returning getter (`() => Promise<T>`) whose
 * concurrent callers share the one in-flight promise until it settles.
 *
 * Errors are never cached: a sync factory that throws propagates the
 * throw, and an async factory that rejects evicts the cached promise, so
 * in both cases the next call retries. Pass `{ ttlMs }` to also expire
 * and recompute a successful value after a window; without a TTL a
 * success is cached forever.
 *
 * For an async factory the TTL window starts when the promise
 * *resolves*, not when it was created - a slow in-flight request never
 * counts as already-expired, and concurrent callers keep sharing the one
 * pending promise until it settles.
 *
 * @example
 * const ranges = functionModule.memoize(fetchIpRanges, { ttlMs: 24 * 60 * 60 * 1000 });
 * await ranges(); // fetches
 * await ranges(); // cached until 24h later
 */
export function memoize<T>(
  factory: () => PromiseLike<T>,
  options?: MemoizeOptions,
): () => Promise<T>;
export function memoize<T>(factory: () => T, options?: MemoizeOptions): () => T;

export function memoize<T>(
  factory: () => T | PromiseLike<T>,
  options?: MemoizeOptions,
): () => T | Promise<T> {
  const ttlMs = options?.ttlMs ?? 0;
  let cache: { value: T | Promise<T>; expiresAt: number } | undefined;
  return () => {
    if (cache === undefined || (ttlMs > 0 && Date.now() >= cache.expiresAt)) {
      const result = factory();
      if (isThenable(result)) {
        const pending = Promise.resolve(result);
        // `Infinity` keeps the entry unexpired while in flight (so a slow
        // request isn't refetched and concurrent callers share it); the
        // TTL window is stamped from resolution below.
        const entry = { value: pending, expiresAt: Infinity };
        cache = entry;
        void pending.then(
          () => {
            entry.expiresAt = Date.now() + ttlMs;
          },
          // Never cache a rejection: evict so a later call retries.
          () => {
            if (cache === entry) cache = undefined;
          },
        );
      } else {
        cache = { value: result, expiresAt: Date.now() + ttlMs };
      }
    }
    return cache.value;
  };
}

/** Duck-type any value with a callable `.then` as a thenable. */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (value !== null) {
    if (value instanceof Promise) {
      return true;
    } else if (
      typeof value === "object" &&
      "then" in value &&
      typeof (value as PromiseLike<T>).then === "function"
    ) {
      return true;
    }
  }
  return false;
}
