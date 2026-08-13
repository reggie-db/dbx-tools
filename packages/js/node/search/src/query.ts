/** Request-shape helpers for search extension write routes and tools. */

import { ValidationError } from "@databricks/appkit";
import { json, object } from "@dbx-tools/shared-core";

/**
 * Parse a JSON document payload the model / a route supplied for a write.
 * Accepts an already-parsed array/object or a JSON string, and always returns
 * an array so a single document and a batch are handled the same way. Throws a
 * {@link ValidationError} on unparseable input so the caller can surface it.
 */
export function toDocumentArray(input: unknown): Array<Record<string, unknown>> {
  const value = typeof input === "string" ? json.parse(input, undefined) : input;
  if (value === undefined) {
    throw new ValidationError("documents must be a JSON object, array, or string");
  }
  const list = Array.isArray(value) ? value : [value];
  return list.filter(object.isRecord);
}
