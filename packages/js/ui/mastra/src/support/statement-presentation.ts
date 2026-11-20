/**
 * Best-effort presentation for Statement Execution results.
 *
 * Genie and Statement Execution expose raw SQL aliases and values but not the
 * labels and number formats Databricks' first-party result grids derive for
 * display. These helpers apply the same class of presentation without changing
 * the raw row values used for sorting and CSV export.
 *
 * @module
 */

import { toLabel } from "@dbx-tools/shared-core";

/** Column metadata available from a Statement Execution manifest. */
export interface StatementColumnPresentation {
  /** Raw result-column name used as the row key. */
  name: string;
  /** SQL base type from the statement manifest. */
  typeName?: string;
}

const ANALYTICS_ACRONYMS = new Map([
  ["api", "API"],
  ["dbu", "DBU"],
  ["id", "ID"],
  ["ids", "IDs"],
  ["kpi", "KPI"],
  ["kpis", "KPIs"],
  ["ly", "LY"],
  ["mom", "MoM"],
  ["mtd", "MTD"],
  ["pct", "%"],
  ["perc", "%"],
  ["percent", "%"],
  ["percentage", "%"],
  ["pspw", "PSPW"],
  ["qoq", "QoQ"],
  ["sql", "SQL"],
  ["usd", "USD"],
  ["wow", "WoW"],
  ["yoy", "YoY"],
  ["ytd", "YTD"],
]);

const PERCENT_TOKENS = new Set(["pct", "perc", "percent", "percentage"]);
const CURRENCY_TOKENS = new Set([
  "amount",
  "cost",
  "dollar",
  "dollars",
  "margin",
  "price",
  "profit",
  "revenue",
  "sales",
  "spend",
  "usd",
]);
const WHOLE_NUMBER_TOKENS = new Set([
  "count",
  "day",
  "days",
  "gallon",
  "gallons",
  "guest",
  "guests",
  "hour",
  "hours",
  "pspw",
  "unit",
  "units",
]);
const INTEGER_SQL_TYPES = new Set([
  "BIGINT",
  "BYTE",
  "INT",
  "INTEGER",
  "LONG",
  "SHORT",
  "SMALLINT",
  "TINYINT",
]);

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const WHOLE_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function nameTokens(name: string): string[] {
  return name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hasToken(tokens: string[], candidates: Set<string>): boolean {
  return tokens.some((token) => candidates.has(token));
}

/** Humanize a raw statement alias while retaining common analytics acronyms. */
export function statementColumnLabel(name: string): string {
  return toLabel(name)
    .split(" ")
    .map((token) => ANALYTICS_ACRONYMS.get(token.toLowerCase()) ?? token)
    .join(" ");
}

/**
 * Format a statement cell for on-screen and document presentation.
 *
 * The API does not expose Metric View display formats. Percentage and currency
 * semantics therefore come from explicit alias tokens, while SQL integer types
 * and count-like names use grouped whole numbers. Unknown numeric measures keep
 * up to two decimals. Non-numeric values pass through unchanged.
 */
export function statementCellText(column: StatementColumnPresentation, value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);

  const tokens = nameTokens(column.name);
  if (hasToken(tokens, PERCENT_TOKENS)) return PERCENT_FORMAT.format(value);
  if (hasToken(tokens, CURRENCY_TOKENS)) return CURRENCY_FORMAT.format(value);
  if (
    INTEGER_SQL_TYPES.has(column.typeName?.toUpperCase() ?? "") ||
    hasToken(tokens, WHOLE_NUMBER_TOKENS)
  ) {
    return WHOLE_NUMBER_FORMAT.format(value);
  }
  return NUMBER_FORMAT.format(value);
}
