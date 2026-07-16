/**
 * Structural deep-equality with an optional custom comparator.
 *
 * {@link deepEqual} mirrors the semantics of the `fast-deep-equal`
 * package (handled: nested plain objects/arrays, `Map`, `Set`, `Date`,
 * `RegExp`, typed arrays, `NaN`, and `+0`/`-0` treated as equal) but is
 * dependency-free so `@dbx-tools/shared-core` keeps no runtime deps.
 *
 * The optional `comparator` short-circuits the structural walk at any
 * node: return `true`/`false` to force the result for that pair, or
 * `undefined` to defer to the built-in comparison. It is invoked for the
 * root pair and recursively for each nested pair, so a caller can, e.g.,
 * compare two domain objects by id while letting everything else fall
 * back to structural equality.
 *
 * @example
 * deepEqual({ a: 1 }, { a: 1 });                 // true
 * deepEqual([1, 2], [1, 2]);                      // true
 * deepEqual(a, b, (x, y) =>
 *   isEntity(x) && isEntity(y) ? x.id === y.id : undefined);
 */
export type DeepEqualComparator = (a: unknown, b: unknown) => boolean | undefined;

export function deepEqual(a: unknown, b: unknown, comparator?: DeepEqualComparator): boolean {
  if (comparator) {
    const decided = comparator(a, b);
    if (decided !== undefined) return decided;
  }

  if (a === b) return true;

  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    // NaN is the only value not equal to itself under `===`.
    return a !== a && b !== b;
  }

  if (a.constructor !== b.constructor) return false;

  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], bArr[i], comparator)) return false;
    }
    return true;
  }

  if (a instanceof Map) {
    const bMap = b as Map<unknown, unknown>;
    if (a.size !== bMap.size) return false;
    for (const [key, value] of a) {
      if (!bMap.has(key)) return false;
      if (!deepEqual(value, bMap.get(key), comparator)) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    const bSet = b as Set<unknown>;
    if (a.size !== bSet.size) return false;
    for (const value of a) {
      if (!bSet.has(value)) return false;
    }
    return true;
  }

  if (a instanceof Date) {
    return a.getTime() === (b as Date).getTime();
  }

  if (a instanceof RegExp) {
    const bRe = b as RegExp;
    return a.source === bRe.source && a.flags === bRe.flags;
  }

  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    const aArr = a as unknown as ArrayLike<number>;
    const bArr = b as unknown as ArrayLike<number>;
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (aArr[i] !== bArr[i]) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        comparator,
      )
    ) {
      return false;
    }
  }
  return true;
}
