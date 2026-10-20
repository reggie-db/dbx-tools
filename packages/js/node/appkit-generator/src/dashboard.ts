/**
 * Deterministic AI/BI dashboard assembly and OBO publication.
 *
 * @module
 */

import { ExecutionError } from "@databricks/appkit";
import { toContext } from "@dbx-tools/appkit";
import { id } from "@dbx-tools/shared-core";
import type { BrandContext } from "@dbx-tools/shared-core";
import {
  GeneratedDashboardSchema,
  type GeneratedDashboard,
  type GeneratedMetric,
  type GeneratedSchema,
  type GeneratorPlan,
} from "@dbx-tools/shared-generator";
import { z } from "zod";
import { resolveGeneratorIdentity } from "./namespace.ts";

const SerializedDashboardSchema = z
  .object({
    datasets: z.array(z.record(z.string(), z.unknown())).min(1),
    pages: z.array(z.record(z.string(), z.unknown())).min(1),
    uiSettings: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Inputs for dashboard assembly and publication. */
export interface CreateGeneratorDashboardInput {
  /** Generated schema containing the fact table. */
  location: GeneratedSchema;
  /** Validated data and metric plan. */
  plan: GeneratorPlan;
  /** Brand applied to the dashboard theme. */
  brand: BrandContext;
  /** SQL warehouse used by the dashboard. */
  warehouseId: string;
  /** Company display name. */
  company: string;
  /** Demo purpose. */
  purpose: string;
}

/** Compile one metric into a reusable Lakeview dataset measure. */
function measure(metric: GeneratedMetric) {
  const expression =
    metric.aggregation === "count"
      ? "COUNT(`*`)"
      : `${metric.aggregation === "sum" ? "SUM" : "AVG"}(\`${metric.column}\`)`;
  return {
    displayName: metric.label,
    description: metric.definition,
    expression,
  };
}

/** Counter widget bound to one dataset measure. */
function counterWidget(metric: GeneratedMetric, index: number) {
  const fieldName = `measure(${metric.label})`;
  return {
    widget: {
      name: `kpi_${metric.name}`,
      queries: [
        {
          name: "main_query",
          query: {
            datasetName: "generated_facts",
            fields: [{ name: fieldName, expression: `MEASURE(\`${metric.label}\`)` }],
            disaggregated: false,
          },
        },
      ],
      spec: {
        version: 2,
        widgetType: "counter",
        encodings: {
          value: {
            fieldName,
            displayName: metric.label,
            ...(metric.unit === "percent"
              ? {
                  format: {
                    type: "number-percent",
                    decimalPlaces: { type: "max", places: 2 },
                  },
                }
              : {}),
          },
        },
        frame: { showTitle: true, title: metric.label },
      },
    },
    position: {
      x: (index % 3) * 4,
      y: 2 + Math.floor(index / 3) * 3,
      width: 4,
      height: 3,
    },
  };
}

/** Build one complete dashboard with automatic companion Genie enabled. */
export function buildGeneratorDashboard(input: CreateGeneratorDashboardInput) {
  const fullTable = `${input.location.catalog}.${input.location.schema}.${input.plan.table}`;
  const dateColumn = input.plan.columns.find(({ generator }) => generator === "date")?.name;
  const categoryColumn = input.plan.columns.find(({ generator }) => generator === "category")?.name;
  const metric = input.plan.metrics[0]!;
  const metricField = `measure(${metric.label})`;
  const kpiRows = Math.ceil(input.plan.metrics.length / 3);
  const chartY = 2 + kpiRows * 3;
  const layout: Record<string, unknown>[] = [
    {
      widget: {
        name: "header",
        multilineTextboxSpec: {
          lines: [`# ${input.company}: ${input.purpose}\n`, `\n`, input.plan.story],
        },
      },
      position: { x: 0, y: 0, width: 12, height: 2 },
    },
    ...input.plan.metrics.map(counterWidget),
  ];
  if (dateColumn) {
    layout.push({
      widget: {
        name: "metric_trend",
        queries: [
          {
            name: "main_query",
            query: {
              datasetName: "generated_facts",
              fields: [
                {
                  name: `daily(${dateColumn})`,
                  expression: `DATE_TRUNC("DAY", \`${dateColumn}\`)`,
                },
                { name: metricField, expression: `MEASURE(\`${metric.label}\`)` },
              ],
              disaggregated: false,
            },
          },
        ],
        spec: {
          version: 3,
          widgetType: "line",
          encodings: {
            x: {
              fieldName: `daily(${dateColumn})`,
              scale: { type: "temporal" },
              displayName: "Date",
            },
            y: {
              fieldName: metricField,
              scale: { type: "quantitative" },
              displayName: metric.label,
            },
          },
          frame: { showTitle: true, title: `${metric.label} trend` },
        },
      },
      position: { x: 0, y: chartY, width: 7, height: 6 },
    });
  }
  if (categoryColumn) {
    layout.push({
      widget: {
        name: "metric_by_category",
        queries: [
          {
            name: "main_query",
            query: {
              datasetName: "generated_facts",
              fields: [
                { name: categoryColumn, expression: `\`${categoryColumn}\`` },
                { name: metricField, expression: `MEASURE(\`${metric.label}\`)` },
              ],
              disaggregated: false,
            },
          },
        ],
        spec: {
          version: 3,
          widgetType: "bar",
          encodings: {
            x: {
              fieldName: categoryColumn,
              scale: { type: "categorical" },
              displayName: categoryColumn,
            },
            y: {
              fieldName: metricField,
              scale: { type: "quantitative" },
              displayName: metric.label,
            },
          },
          frame: { showTitle: true, title: `${metric.label} by ${categoryColumn}` },
        },
      },
      position: { x: 7, y: chartY, width: 5, height: 6 },
    });
  }
  return SerializedDashboardSchema.parse({
    datasets: [
      {
        name: "generated_facts",
        displayName: input.plan.table,
        asset_name: fullTable,
        columns: input.plan.metrics.map(measure),
      },
    ],
    pages: [
      {
        name: "overview",
        displayName: "Overview",
        pageType: "PAGE_TYPE_CANVAS",
        layoutVersion: "GRID_V1",
        layout,
      },
    ],
    uiSettings: {
      theme: {
        canvasBackgroundColor: {
          light: input.brand.colors.background,
          dark: input.brand.colors.foreground,
        },
        widgetBackgroundColor: {
          light: input.brand.colors.surface,
          dark: input.brand.colors.primary,
        },
        fontColor: {
          light: input.brand.colors.foreground,
          dark: input.brand.colors.background,
        },
        selectionColor: {
          light: input.brand.colors.primary,
          dark: input.brand.colors.accent,
        },
        visualizationColors: [
          input.brand.colors.primary,
          input.brand.colors.accent,
          input.brand.colors.primaryHover,
          input.brand.colors.muted,
        ],
        widgetHeaderAlignment: "LEFT",
      },
      genieSpace: {
        isEnabled: true,
        enablementMode: "AUTO",
      },
    },
  });
}

/** Create and publish a dashboard as the active OBO user. */
export async function createGeneratorDashboard(
  input: CreateGeneratorDashboardInput,
  signal?: AbortSignal,
): Promise<GeneratedDashboard> {
  const identity = await resolveGeneratorIdentity();
  if (identity.principal !== input.location.principal) {
    throw new ExecutionError("Dashboard principal does not match the active OBO user");
  }
  const legacy = identity.userClient.toLegacyWorkspaceClient();
  const parentPath = `/Workspace/Users/${identity.principal}/.dbx-tools/generator/${input.location.schema}`;
  const context = signal ? toContext(signal) : undefined;
  await legacy.workspace.mkdirs({ path: parentPath }, context);
  const created = await legacy.lakeview.create(
    {
      dashboard: {
        display_name: `${input.company} ${input.purpose} ${id(6)}`,
        parent_path: parentPath,
        warehouse_id: input.warehouseId,
        serialized_dashboard: JSON.stringify(buildGeneratorDashboard(input)),
      },
    },
    context,
  );
  if (!created.dashboard_id) {
    throw new ExecutionError("Lakeview create returned no dashboard id");
  }
  await legacy.lakeview.publish(
    {
      dashboard_id: created.dashboard_id,
      warehouse_id: input.warehouseId,
      embed_credentials: false,
    },
    context,
  );
  return GeneratedDashboardSchema.parse({
    dashboardId: created.dashboard_id,
    ...(created.path ? { path: created.path } : {}),
    companionGenie: "AUTO",
  });
}
