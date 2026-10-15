/**
 * Browser-safe contracts for generated Databricks demo assets.
 *
 * @module
 */

import { z } from "zod";
import { BrandPackageSchema } from "./brand.ts";
import { KpiResearchResultSchema, ResearchedKpiSchema } from "./kpi.ts";

const nonBlankString = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, "Expected a lowercase SQL identifier.");

/** Presentation created after generated data is validated. */
export const PresentationModeSchema = z.enum(["dashboard", "genie"]);

/** Presentation mode. */
export type PresentationMode = z.infer<typeof PresentationModeSchema>;

/** Complete input for the governed generator workflow. */
export const GeneratorRequestSchema = z
  .object({
    company: nonBlankString.max(200).describe("Company or brand represented by the demo."),
    purpose: nonBlankString.max(200).describe("Short purpose used in schema and asset names."),
    queries: z
      .array(nonBlankString.max(500))
      .min(1)
      .max(10)
      .describe("Business questions that shape KPI research and generated data."),
    website: z
      .string()
      .url()
      .optional()
      .describe("Known company website for brand disambiguation."),
    presentation: PresentationModeSchema.default("dashboard").describe(
      "Dashboard with automatic companion Genie, or standalone Genie without a dashboard.",
    ),
    rowCount: z
      .number()
      .int()
      .min(1_000)
      .max(100_000)
      .default(50_000)
      .describe("Rows generated in the primary fact table."),
  })
  .strict()
  .describe("Request for a per-user Databricks demo data environment.");

/** Generator workflow input after defaults. */
export type GeneratorRequest = z.output<typeof GeneratorRequestSchema>;

/** Supported deterministic column generators. */
export const GeneratedColumnSchema = z.discriminatedUnion("generator", [
  z
    .object({
      name: identifier.describe("Column name."),
      generator: z.literal("id"),
      description: nonBlankString.describe("Column business meaning."),
    })
    .strict(),
  z
    .object({
      name: identifier.describe("Column name."),
      generator: z.literal("date"),
      description: nonBlankString.describe("Column business meaning."),
      days: z.number().int().min(30).max(1_095).describe("Generated history window in days."),
    })
    .strict(),
  z
    .object({
      name: identifier.describe("Column name."),
      generator: z.literal("category"),
      description: nonBlankString.describe("Column business meaning."),
      values: z.array(nonBlankString.max(80)).min(2).max(12).describe("Skewed category values."),
    })
    .strict(),
  z
    .object({
      name: identifier.describe("Column name."),
      generator: z.literal("number"),
      description: nonBlankString.describe("Column business meaning."),
      minimum: z.number().describe("Minimum generated value."),
      maximum: z.number().describe("Maximum generated value."),
      decimals: z.number().int().min(0).max(4).default(2).describe("Decimal precision."),
    })
    .strict(),
  z
    .object({
      name: identifier.describe("Column name."),
      generator: z.literal("boolean"),
      description: nonBlankString.describe("Column business meaning."),
      trueProbability: z.number().min(0.01).max(0.99).describe("Share of true rows."),
    })
    .strict(),
]);

/** Deterministic generated column specification. */
export type GeneratedColumn = z.infer<typeof GeneratedColumnSchema>;

/** KPI binding compiled into validation SQL and dashboard measures. */
export const GeneratedMetricSchema = ResearchedKpiSchema.extend({
  aggregation: z
    .enum(["count", "sum", "average"])
    .describe("Safe aggregate compiled by the generator."),
  column: identifier.optional().describe("Numeric source column; omitted for count."),
}).strict();

/** KPI binding. */
export type GeneratedMetric = z.infer<typeof GeneratedMetricSchema>;

/** Structured plan compiled into SQL and presentation assets. */
export const GeneratorPlanSchema = z
  .object({
    table: identifier.describe("Primary generated Delta table name."),
    rowCount: z.number().int().min(1_000).max(100_000).describe("Rows to generate."),
    columns: z
      .array(GeneratedColumnSchema)
      .min(4)
      .max(16)
      .describe("Typed deterministic column generators."),
    metrics: z.array(GeneratedMetricSchema).min(1).max(6).describe("Dashboard and Genie KPIs."),
    story: nonBlankString.describe("Business anomaly and impact represented in the data."),
    sampleQuestions: z
      .array(nonBlankString.max(300))
      .min(3)
      .max(8)
      .describe("Questions supported by the generated table."),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const [index, column] of value.columns.entries()) {
      if (names.has(column.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", index, "name"],
          message: "Generated column names must be unique.",
        });
      }
      names.add(column.name);
    }
    if (!value.columns.some(({ generator }) => generator === "id")) {
      ctx.addIssue({ code: "custom", path: ["columns"], message: "An id column is required." });
    }
    if (!value.columns.some(({ generator }) => generator === "date")) {
      ctx.addIssue({ code: "custom", path: ["columns"], message: "A date column is required." });
    }
    if (!value.columns.some(({ generator }) => generator === "category")) {
      ctx.addIssue({
        code: "custom",
        path: ["columns"],
        message: "A category column is required.",
      });
    }
    const numeric = new Set(
      value.columns.filter(({ generator }) => generator === "number").map(({ name }) => name),
    );
    for (const [index, metric] of value.metrics.entries()) {
      if (metric.aggregation !== "count" && (!metric.column || !numeric.has(metric.column))) {
        ctx.addIssue({
          code: "custom",
          path: ["metrics", index, "column"],
          message: "Sum and average metrics require a generated numeric column.",
        });
      }
    }
  })
  .describe("Validated plan for deterministic synthetic data and analytics assets.");

/** Structured generator plan. */
export type GeneratorPlan = z.infer<typeof GeneratorPlanSchema>;

/** Input for the standalone structured data-planning tool. */
export const PlanGeneratorDataRequestSchema = z
  .object({
    request: GeneratorRequestSchema,
    brand: BrandPackageSchema,
    kpiResearch: KpiResearchResultSchema,
  })
  .strict()
  .describe("Inputs needed to build a typed generator plan.");

/** Input for the standalone structured data-planning tool. */
export type PlanGeneratorDataRequest = z.infer<typeof PlanGeneratorDataRequestSchema>;

/** Location and trusted identity for one generated schema. */
export const GeneratedSchemaSchema = z
  .object({
    catalog: identifier.describe("Configured Unity Catalog."),
    schema: identifier.describe("Per-user generated schema."),
    fullName: nonBlankString.describe("Quoted-safe catalog.schema display name."),
    principal: nonBlankString.describe("Trusted OBO Databricks user name."),
  })
  .strict()
  .describe("Provisioned per-user Unity Catalog schema.");

/** Provisioned generated schema. */
export type GeneratedSchema = z.infer<typeof GeneratedSchemaSchema>;

/** Input for per-user schema provisioning. */
export const ProvisionGeneratorSchemaRequestSchema = z
  .object({
    request: GeneratorRequestSchema.pick({ company: true, purpose: true }),
  })
  .strict()
  .describe("Request to provision the active user's generated schema.");

/** Input for per-user schema provisioning. */
export type ProvisionGeneratorSchemaRequest = z.infer<typeof ProvisionGeneratorSchemaRequestSchema>;

/** Input for generated data materialization. */
export const MaterializeGeneratorDataRequestSchema = z
  .object({
    location: GeneratedSchemaSchema,
    plan: GeneratorPlanSchema,
  })
  .strict()
  .describe("Request to materialize and validate generated Delta data.");

/** Input for generated data materialization. */
export type MaterializeGeneratorDataRequest = z.infer<typeof MaterializeGeneratorDataRequestSchema>;

/** Created tables and KPI validation statements. */
export const MaterializedGeneratorDataSchema = z
  .object({
    tables: z.array(nonBlankString).min(1).describe("Created fully qualified Delta tables."),
    validationStatements: z
      .record(identifier, nonBlankString)
      .describe("Statement IDs keyed by validated KPI name."),
  })
  .strict()
  .describe("Materialized and validated generated data.");

/** Created tables and KPI validation statements. */
export type MaterializedGeneratorData = z.infer<typeof MaterializedGeneratorDataSchema>;

/** Input shared by dashboard and standalone Genie creation tools. */
export const CreateGeneratorPresentationRequestSchema = z
  .object({
    request: GeneratorRequestSchema.pick({
      company: true,
      purpose: true,
    }),
    location: GeneratedSchemaSchema,
    plan: GeneratorPlanSchema,
    brand: BrandPackageSchema,
  })
  .strict()
  .describe("Request to create a presentation asset over generated data.");

/** Input shared by dashboard and standalone Genie creation tools. */
export type CreateGeneratorPresentationRequest = z.infer<
  typeof CreateGeneratorPresentationRequestSchema
>;

/** Dashboard output with its automatic companion Genie Agent. */
export const GeneratedDashboardSchema = z
  .object({
    dashboardId: nonBlankString.describe("Created Lakeview dashboard ID."),
    path: nonBlankString.optional().describe("Workspace path, when returned."),
    companionGenie: z.literal("AUTO").describe("Dashboard-published companion Genie mode."),
  })
  .strict();

/** Published dashboard with automatic companion Genie. */
export type GeneratedDashboard = z.infer<typeof GeneratedDashboardSchema>;

/** Standalone Genie output used only when no dashboard is requested. */
export const GeneratedGenieSpaceSchema = z
  .object({
    spaceId: nonBlankString.describe("Created standalone Genie space ID."),
    title: nonBlankString.describe("Genie space title."),
  })
  .strict();

/** Created standalone Genie space. */
export type GeneratedGenieSpace = z.infer<typeof GeneratedGenieSpaceSchema>;

/** Terminal workflow output. */
export const GeneratedAssetsSchema = z
  .object({
    request: GeneratorRequestSchema,
    schema: GeneratedSchemaSchema,
    tables: z.array(nonBlankString).min(1).describe("Created fully qualified Delta tables."),
    brand: BrandPackageSchema,
    kpiResearch: KpiResearchResultSchema,
    plan: GeneratorPlanSchema,
    dashboard: GeneratedDashboardSchema.optional(),
    genie: GeneratedGenieSpaceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.dashboard === undefined) === (value.genie === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one dashboard or standalone Genie space is required.",
      });
    }
  })
  .describe("Generated Databricks data and presentation assets.");

/** Terminal generator workflow output. */
export type GeneratedAssets = z.infer<typeof GeneratedAssetsSchema>;
