/**
 * Translation between the browser-safe search contract and the Databricks
 * Vector Search query API, kept in one place so the client, the tools, and the
 * routes never hand-roll a `filters_json` string or unpack a `data_array` by
 * hand.
 *
 *   - {@link toQueryType} maps the friendly {@link SearchMode} onto the API's
 *     `query_type` (`HYBRID` / `ANN`). Keyword-only search rides on `ANN` with
 *     text but no vector, which Databricks answers with its BM25 path.
 *   - {@link compileFilter} turns the `{ column: value }` filter object (with
 *     optional operator maps like `{ ">=": 10 }`) into the `filters_json`
 *     string the API expects, so a caller never learns Databricks' filter
 *     spelling.
 *   - {@link toHits} unpacks the columnar `{ manifest, result }` response into
 *     `{ id, score, fields }` hits, pulling the score out of the reserved
 *     `__db_score` / `score` column and the id out of the primary-key column.
 *
 * @module
 */

import { ValidationError } from "@databricks/appkit";
import type { SearchHit, SearchMode } from "@dbx-tools/shared-ai-search";
import { json, object } from "@dbx-tools/shared-core";

/** The column name Databricks Vector Search returns the relevance score under. */
const SCORE_COLUMN = "__db_score";

/** Map a {@link SearchMode} onto the serving API `query_type`. */
export function toQueryType(mode: SearchMode): string {
  return mode === "hybrid" ? "HYBRID" : "ANN";
}

/**
 * Compile a `{ column: value }` filter object into the `filters_json` string
 * the query API expects. A scalar becomes an equality; an array becomes an
 * IN-style match; an operator map (`{ ">=": 10, "<": 20 }`) expands to the
 * `column operator` keys Databricks uses. Returns `undefined` for an empty
 * filter so the field is omitted rather than sent as `{}`.
 */
export function compileFilter(filter: Record<string, unknown> | undefined): string | undefined {
  if (!filter || Object.keys(filter).length === 0) return undefined;
  const compiled: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(filter)) {
    if (object.isRecord(value)) {
      for (const [op, operand] of Object.entries(value)) {
        compiled[`${column} ${op}`] = operand;
      }
    } else {
      compiled[column] = value;
    }
  }
  return JSON.stringify(compiled);
}

/** A minimal structural view of the Vector Search query response. */
export interface QueryResponseLike {
  manifest?: { columns?: Array<{ name?: string }> };
  result?: { data_array?: Array<Array<unknown>> };
  next_page_token?: string;
}

/**
 * Unpack a columnar query response into {@link SearchHit}s. The manifest names
 * the columns in order; each row is a positional array. The score comes from
 * the reserved score column and the id from `primaryKey` (falling back to the
 * first column when the key is unknown). The score column is stripped from
 * `fields` so a hit's fields are just the document.
 */
export function toHits(
  response: QueryResponseLike,
  primaryKey: string | undefined,
  indexName?: string,
): SearchHit[] {
  const columns = (response.manifest?.columns ?? []).map((c) => c.name ?? "");
  const rows = response.result?.data_array ?? [];
  const scoreIdx = columns.indexOf(SCORE_COLUMN);
  const keyIdx = primaryKey ? columns.indexOf(primaryKey) : -1;
  return rows.map((row, rowIndex) => {
    const fields: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      if (i === scoreIdx || !name) return;
      fields[name] = row[i];
    });
    const scoreRaw = scoreIdx >= 0 ? Number(row[scoreIdx]) : NaN;
    const idRaw =
      keyIdx >= 0 ? row[keyIdx] : primaryKey ? fields[primaryKey] : (row[0] ?? rowIndex);
    return {
      id: String(idRaw ?? rowIndex),
      score: Number.isFinite(scoreRaw) ? scoreRaw : 0,
      fields,
      ...(indexName ? { index: indexName } : {}),
    };
  });
}

/**
 * The columns to request from an index for a search. When neither the request
 * nor the index config names columns, the score column alone is requested and
 * the primary key is appended so a hit always has an id. Callers that want the
 * whole document should pass the index's own column list.
 */
export function toRequestColumns(
  requested: readonly string[] | undefined,
  fallback: readonly string[] | undefined,
  primaryKey: string | undefined,
): string[] {
  const base = requested && requested.length > 0 ? requested : (fallback ?? []);
  const columns = new Set<string>(base);
  if (primaryKey) columns.add(primaryKey);
  if (columns.size === 0 && primaryKey) columns.add(primaryKey);
  return [...columns];
}

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
