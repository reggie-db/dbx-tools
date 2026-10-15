/**
 * Deterministic Databricks SQL compilation, execution, and validation.
 *
 * @module
 */

import { ExecutionError, type WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { asyncUtils } from "@dbx-tools/shared-core";
import { MaterializedGeneratorDataSchema } from "@dbx-tools/shared-generator/workflow";
import type {
  GeneratedColumn,
  GeneratedMetric,
  GeneratedSchema,
  GeneratorPlan,
  MaterializedGeneratorData,
} from "@dbx-tools/shared-generator/workflow";
import { resolveGeneratorIdentity } from "./namespace.ts";

const TERMINAL_STATEMENT_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]);
type StatementResponse = Awaited<ReturnType<WorkspaceClient["statementExecution"]["getStatement"]>>;

/** Quote one already-validated SQL identifier. */
function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

/** Quote one SQL string literal. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Compile one safe column generator into a SQL expression. */
function columnExpression(column: GeneratedColumn): string {
  const salt = quoteLiteral(column.name);
  switch (column.generator) {
    case "id":
      return `concat('ID-', lpad(cast(id as string), 8, '0'))`;
    case "date":
      return `date_sub(current_date(), pmod(xxhash64(id, ${salt}), ${column.days}))`;
    case "category": {
      const values = column.values.map(quoteLiteral);
      const fallback = `element_at(array(${values.join(", ")}), pmod(xxhash64(id, ${salt}), ${values.length}) + 1)`;
      return `case when pmod(xxhash64(id, ${salt}), 100) < 55 then ${values[0]} when pmod(xxhash64(id, ${salt}), 100) < 80 then ${values[1]} else ${fallback} end`;
    }
    case "number": {
      const spread = column.maximum - column.minimum;
      return `round((${column.minimum} + (pmod(xxhash64(id, ${salt}), 1000000) / 999999.0) * ${spread}) * case when pmod(xxhash64(id, ${salt}, 'anomaly'), 100) < 8 then 1.65 else 1 end, ${column.decimals})`;
    }
    case "boolean":
      return `pmod(xxhash64(id, ${salt}), 10000) < ${Math.round(column.trueProbability * 10_000)}`;
    default: {
      const exhaustive: never = column;
      throw new TypeError(`Unsupported generated column: ${String(exhaustive)}`);
    }
  }
}

/** Compile the generated table statement without accepting model-authored SQL. */
export function compileGeneratorTableSql(location: GeneratedSchema, plan: GeneratorPlan): string {
  const columns = plan.columns.map(
    (column) => `${columnExpression(column)} AS ${quoteIdentifier(column.name)}`,
  );
  return [
    `CREATE OR REPLACE TABLE ${quoteIdentifier(location.catalog)}.${quoteIdentifier(location.schema)}.${quoteIdentifier(plan.table)}`,
    `COMMENT ${quoteLiteral(plan.story)}`,
    "AS SELECT",
    `  ${columns.join(",\n  ")}`,
    `FROM range(${plan.rowCount})`,
  ].join("\n");
}

/** Compile one KPI validation query from its typed aggregate. */
export function compileMetricValidationSql(table: string, metric: GeneratedMetric): string {
  const aggregate =
    metric.aggregation === "count"
      ? "count(*)"
      : `${metric.aggregation === "sum" ? "sum" : "avg"}(${quoteIdentifier(metric.column!)})`;
  return `SELECT ${aggregate} AS ${quoteIdentifier(metric.name)} FROM ${table}`;
}

/** Execute one statement and wait for its terminal response. */
export async function executeGeneratorStatement(
  client: WorkspaceClient,
  warehouseId: string,
  statement: string,
  location: Pick<GeneratedSchema, "catalog" | "schema">,
  signal?: AbortSignal,
): Promise<StatementResponse> {
  const context = signal ? databricks.toContext(signal) : undefined;
  let response = await client.statementExecution.executeStatement(
    {
      warehouse_id: warehouseId,
      statement,
      catalog: location.catalog,
      schema: location.schema,
      wait_timeout: "50s",
      on_wait_timeout: "CONTINUE",
    },
    context,
  );
  if (!TERMINAL_STATEMENT_STATES.has(response.status?.state ?? "")) {
    const statementId = response.statement_id;
    if (!statementId) throw new ExecutionError("Statement execution returned no statement id");
    for await (const polled of asyncUtils.poll<StatementResponse>(
      ({ signal: pollSignal }) =>
        client.statementExecution.getStatement(
          { statement_id: statementId },
          databricks.toContext(pollSignal),
        ),
      {
        intervalMs: 1_000,
        timeoutMs: 180_000,
        ...(signal ? { signal } : {}),
        predicate: (value) => !TERMINAL_STATEMENT_STATES.has(value.status?.state ?? ""),
      },
    )) {
      response = polled;
    }
  }
  if (response.status?.state !== "SUCCEEDED") {
    throw new ExecutionError(
      response.status?.error?.message ??
        `Statement ended in ${response.status?.state ?? "UNKNOWN"}`,
    );
  }
  return response;
}

/** Materialize generated data as the OBO user and validate every planned KPI. */
export async function materializeGeneratorData(
  location: GeneratedSchema,
  plan: GeneratorPlan,
  warehouseId: string,
  signal?: AbortSignal,
): Promise<MaterializedGeneratorData> {
  const identity = await resolveGeneratorIdentity();
  if (identity.principal !== location.principal) {
    throw new ExecutionError("Generator schema principal does not match the active OBO user");
  }
  await executeGeneratorStatement(
    identity.userClient,
    warehouseId,
    compileGeneratorTableSql(location, plan),
    location,
    signal,
  );
  const fullTable = `${location.catalog}.${location.schema}.${plan.table}`;
  const validationStatements: Record<string, string> = {};
  for (const metric of plan.metrics) {
    const response = await executeGeneratorStatement(
      identity.userClient,
      warehouseId,
      compileMetricValidationSql(fullTable, metric),
      location,
      signal,
    );
    if (!response.statement_id) {
      throw new ExecutionError(`Validation for ${metric.name} returned no statement id`);
    }
    validationStatements[metric.name] = response.statement_id;
  }
  return MaterializedGeneratorDataSchema.parse({
    tables: [fullTable],
    validationStatements,
  });
}
