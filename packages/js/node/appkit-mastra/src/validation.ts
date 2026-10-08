/**
 * Request-body validation helpers shared by every route that parses a JSON
 * body with a schema from `@dbx-tools/shared-mastra`.
 *
 * A schema library's own issue text quotes the received body back, so it is
 * logged rather than returned. What a client gets instead is a stable message
 * plus the field paths that failed, which is enough to highlight the offending
 * inputs.
 *
 * @module
 */
import { object } from "@dbx-tools/shared-core";

/** The subset of a failed parse result these helpers read. */
export interface SchemaIssues {
  issues: ReadonlyArray<{ path: PropertyKey[] }>;
}

/** Distinct dot-joined field paths a failed parse flagged. */
export function invalidFields(error: SchemaIssues): string[] {
  return [
    ...object
      .sequence(error.issues)
      .map((issue) => issue.path.map(String).join("."))
      .filter(Boolean)
      .distinct(),
  ];
}
