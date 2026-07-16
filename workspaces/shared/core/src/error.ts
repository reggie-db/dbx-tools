/**
 * Error normalization helpers: collapse the ubiquitous
 * `err instanceof Error ? err.message : String(err)` dance into a single
 * call, walk `cause` / `AggregateError` chains, and coerce any thrown
 * value into a real `Error`. Dependency-free and browser-safe.
 */

/**
 * Normalize any thrown value into an `Error`. Returns `value` unchanged
 * when it already is an `Error`, otherwise wraps its {@link errorMessage}
 * in a fresh `Error`. Use when a consumer needs a real `Error` object
 * (React error state, `reject`, rethrow) rather than just a printable
 * string.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

/**
 * Extract a human-readable message from any thrown value. Returns
 * `value.message` when `value` is an `Error`, otherwise coerces via
 * `String(value)`. Collapses the ubiquitous
 *
 * ```ts
 * err instanceof Error ? err.message : String(err)
 * ```
 *
 * dance into a single helper, useful for log attributes and any other
 * "give me something printable" context.
 */
export function errorMessage(value: unknown): string {
  const message = errorMessages(value).next().value;
  return message ?? String(value);
}

/**
 * Yield `message` / `errorCode` strings from every node in the error
 * tree (see {@link errorNodes}). Used by {@link errorMessage} and
 * message predicates elsewhere.
 */
export function* errorMessages(value: unknown): Generator<string, void, undefined> {
  for (const node of errorNodes(value)) {
    if (typeof node === "object") {
      for (const key of ["message", "errorCode"]) {
        if (key in node) {
          const value = (node as Record<string, unknown>)[key];
          if (typeof value === "string" && value) {
            yield value;
          }
        }
      }
    } else if (typeof node === "string" && node) {
      yield node;
    }
  }
}

/**
 * Depth-first walk of an error value: the root, then `errors` (e.g.
 * `AggregateError`) and `cause` chains. Cycle-safe via a `seen` set.
 */
export function* errorNodes(err: unknown): Generator<NonNullable<unknown>, void, undefined> {
  const seen = new Set<unknown>();

  function* visit(node: unknown): Generator<NonNullable<unknown>, void, undefined> {
    if (node === undefined || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) {
        yield* visit(child);
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    yield node;
    if (typeof node === "object") {
      for (const key of ["errors", "cause"]) {
        if (key in node) {
          const value = (node as Record<string, unknown>)[key];
          yield* visit(value);
        }
      }
    }
  }
  yield* visit(err);
}
