/**
 * Small, dependency-free iterable helpers shared across packages.
 */

/**
 * Type guard for a non-string {@link Iterable}.
 *
 * Deliberately excludes values that are technically iterable but should be
 * treated as scalars here - strings, `String`/`RegExp` objects, and functions -
 * so a lone string is never spread character-by-character.
 *
 * @typeParam T - Element type asserted for the iterable.
 * @param value - Value to test.
 * @returns `true` (narrowing `value` to `Iterable<T>`) for a non-string iterable.
 */
export function isIterable<T = unknown>(value: unknown): value is Iterable<T> {
  return (
    value != null &&
    typeof value !== "string" &&
    !(value instanceof String) &&
    !(value instanceof RegExp) &&
    typeof value !== "function" &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

/**
 * Flattens a mix of single items and iterables into one lazy {@link Generator}.
 *
 * Arguments are emitted in order: `null`/`undefined` are skipped, non-string
 * iterables (per {@link isIterable}) are yielded element-by-element, and
 * anything else (including strings) is yielded as a single item. Handy for
 * concatenating an existing sequence with extra values without allocating an
 * intermediate array.
 *
 * @typeParam T - Element type produced by the generator.
 * @param items - Items and/or iterables to flatten, in order.
 * @returns A generator over the flattened elements.
 */
export function* generator<T>(...items: (T | Iterable<T> | null | undefined)[]): Generator<T> {
  for (const item of items) {
    if (item === null || item === undefined) continue;
    else if (isIterable(item)) {
      yield* item;
    } else {
      yield item;
    }
  }
}
