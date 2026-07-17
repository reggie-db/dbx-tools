/**
 * Small value guards, coercions, and object-shape types: narrow parsed JSON to
 * a record, coerce loose truthy/falsy strings to a boolean, and describe object
 * shapes (`NameLike`, `NonFunctionKeys`). Dependency-free and browser-safe.
 */

/** Minimal shape for objects that expose an optional `name` (e.g. AppKit plugins). */
export interface NameLike {
  name?: string;
}

export type NonFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K;
}[keyof T];

/**
 * Narrow `value` to a plain (non-array) object. Use as a type guard
 * before indexing into / mutating parsed JSON so the access is
 * type-safe.
 *
 * @example
 * if (isRecord(parsed)) parsed.foo = 1;
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a loose boolean-ish value to a real `boolean`, or `undefined`
 * when it can't be interpreted. Recognizes `true`/`t`/`on`/`1`/`yes`/`y`
 * and their negatives (case- and whitespace-insensitive for strings), as
 * well as the numbers `1` and `0`.
 */
export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  else if (typeof value === "string") {
    value = value.trim().toLowerCase();
    if (
      value === "true" ||
      value == "t" ||
      value === "on" ||
      value === "1" ||
      value === "yes" ||
      value === "y"
    )
      return true;
    else if (
      value === "false" ||
      value == "f" ||
      value === "off" ||
      value === "0" ||
      value === "no" ||
      value === "n"
    )
      return false;
  } else if (typeof value === "number") {
    if (value === 1) return true;
    else if (value === 0) return false;
  }
  return undefined;
}
