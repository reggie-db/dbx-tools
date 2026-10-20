/**
 * Databricks Statement Execution helpers for the Mastra plugin.
 *
 * Wraps `client.statementExecution.getStatement` with the shape and
 * size handling the plugin's tools and the `/embed/data/:id` route
 * both need: a low-level fetch that returns a raw
 * `{columns, rows, rowCount}` shape and coerces numeric strings to
 * numbers so downstream charts and aggregations don't have to, plus a
 * hard row cap callers clamp `limit` to so a runaway result set can't
 * hose a response. Upstream 404s are detected via
 * `error.errorContext(err).notFound` at the call sites.
 *
 * Not Genie-specific: a Databricks `statement_id` is workspace
 * scoped and lives in the Statement Execution API regardless of
 * which producer (Genie, a tool, a notebook, etc.) submitted the
 * query. Co-located here so consumers can fetch / cap / handle
 * 404s without reaching into the Genie tool module.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { toContext } from "@dbx-tools/appkit";
import { toNumber } from "@dbx-tools/shared-core";
import {
  type GenieDatasetData,
  type GenieVisualizationData,
  GenieVisualizationDataSchema,
} from "@dbx-tools/shared-mastra";

/**
 * Hard server-side cap on rows returned by the
 * `/embed/data/:id` route. Sized to keep responses small
 * enough for inline tables to render snappily; the route surfaces
 * a `truncated` flag whenever the upstream `rowCount` exceeds
 * this so end users know they're seeing a sample.
 */
export const STATEMENT_ROW_CAP = 500;

/**
 * Best-effort numeric coercion for the Statement Execution API's
 * all-strings cells. Leaves non-numeric strings (and explicit
 * `null`s) intact.
 *
 * Both of {@link object.toNumber}'s string leniencies are disabled, because a
 * cell's other characters belong to the VALUE: a `"1,000"` in a text column is
 * the string the query returned, and a `"25%"` must not silently arrive as
 * `0.25` in a table the user is reading.
 */
function coerceCell(cell: string | null): unknown {
  if (cell === null) return null;
  return toNumber(cell, { separators: false, percent: false }) ?? cell;
}

type StatementResponse = Awaited<ReturnType<WorkspaceClient["statementExecution"]["getStatement"]>>;

async function fetchStatementResponse(
  client: WorkspaceClient,
  statementId: string,
  signal?: AbortSignal,
): Promise<StatementResponse> {
  const context = signal ? toContext(signal) : undefined;
  return client.statementExecution.getStatement({ statement_id: statementId }, context);
}

function normalizedStatementData(response: StatementResponse, limit?: number): GenieDatasetData {
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => column.name ?? "");
  const dataArray = (response.result?.data_array ?? []) as Array<Array<string | null>>;
  const sliced = limit !== undefined && limit >= 0 ? dataArray.slice(0, limit) : dataArray;
  const rows = sliced.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column] = coerceCell(row[index] ?? null);
    });
    return record;
  });
  return {
    columns,
    rows,
    rowCount: response.manifest?.total_row_count ?? dataArray.length,
  };
}

function visualizationData(response: StatementResponse, limit?: number): GenieVisualizationData {
  const dataArray = (response.result?.data_array ?? []) as Array<Array<string | null>>;
  return GenieVisualizationDataSchema.parse({
    manifest: {
      schema: {
        columns: (response.manifest?.schema?.columns ?? []).map((column) => ({
          name: column.name,
          type_name: column.type_name,
        })),
      },
    },
    result: {
      data_array: limit !== undefined && limit >= 0 ? dataArray.slice(0, limit) : dataArray,
    },
  });
}

/** Normalized and AppKit-native projections of one statement response. */
export interface StatementEmbedData {
  /** Row records used by tools, sortable tables, and chart planners. */
  data: GenieDatasetData;
  /** Manifest and row arrays consumed by AppKit UI's Genie visualization. */
  visualization: GenieVisualizationData;
}

/**
 * Fetch a single statement's rows via the Statement Execution API
 * and reshape into the shared {@link GenieDatasetData} shape
 * (column array + row records).
 *
 * Optional `limit` slices the returned `rows` client-side so the
 * agent can scan a small sample without paging the full result
 * set into context. `rowCount` always reflects the upstream total
 * so callers know when the slice truncated.
 *
 * Exported because every consumer in the plugin (the
 * `get_statement` tool, the `prepare_chart` dataset resolver, and
 * the `/embed/data/:id` route) needs the exact same
 * fetch + coercion pipeline so LLM-side `get_statement` output
 * and UI-side `[data:<id>]` rendering stay shape-identical for
 * the same `statement_id`.
 */
export async function fetchStatementData(
  client: WorkspaceClient,
  statementId: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<GenieDatasetData> {
  const response = await fetchStatementResponse(client, statementId, options?.signal);
  return normalizedStatementData(response, options?.limit);
}

/**
 * Fetch one statement once and project it for both the existing data table and
 * AppKit UI's native Genie visualization.
 */
export async function fetchStatementEmbedData(
  client: WorkspaceClient,
  statementId: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<StatementEmbedData> {
  const response = await fetchStatementResponse(client, statementId, options?.signal);
  return {
    data: normalizedStatementData(response, options?.limit),
    visualization: visualizationData(response, options?.limit),
  };
}
