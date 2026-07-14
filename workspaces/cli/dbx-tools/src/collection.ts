export interface IsEmptyOptions {
  includeEmptyStrings?: boolean;
}

/**
 * Returns true if `value` is recursively empty.
 *
 * Empty values:
 *   - null / undefined
 *   - empty arrays (or arrays whose elements are all empty)
 *   - empty objects (or objects whose values are all empty)
 *   - empty Map / Set (or whose entries are all empty)
 *   - optionally empty strings ("" or whitespace)
 */
export function isEmpty(value: unknown, options: IsEmptyOptions = {}): boolean {
  const { includeEmptyStrings = false } = options;

  function visit(value: unknown, seen: WeakSet<object>): boolean {
    if (value == null) {
      return true;
    } else if (typeof value === "string") {
      return includeEmptyStrings ? value.length === 0 : false;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      typeof value === "symbol" ||
      typeof value === "function"
    ) {
      return false;
    } else if (typeof value !== "object") {
      return false;
    }

    if (seen.has(value)) {
      return true;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.every((item) => visit(item, seen));
    } else if (value instanceof Map) {
      for (const [key, val] of value) {
        if (!visit(key, seen) || !visit(val, seen)) {
          return false;
        }
      }
      return true;
    } else if (value instanceof Set) {
      for (const item of value) {
        if (!visit(item, seen)) {
          return false;
        }
      }
      return true;
    } else {
      for (const val of Object.values(value)) {
        if (!visit(val, seen)) {
          return false;
        }
      }
      return true;
    }
  }

  return visit(value, new WeakSet());
}
