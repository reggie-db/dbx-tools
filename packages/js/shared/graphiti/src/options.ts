/**
 * Browser-safe Graphiti configuration shared by every runtime.
 *
 * This module owns the Graphiti option schema, defaults, and environment
 * mapping. Node launches the Python runtime with this environment unchanged;
 * PythonMonkey owns model routing and authentication.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { ChatModelClassOptionSchema } from "@dbx-tools/shared-model-gateway/options";
import { z } from "zod";

const graphitiText = (description: string) => z.string().trim().min(1).describe(description);

export const GraphitiOptionsSchema = z
  .object({
    profile: options.DatabricksOptionsSchema.shape.profile.describe(
      "Databricks profile used for model discovery and authentication.",
    ),
    bearer: graphitiText("Optional bearer token required by every Graphiti HTTP endpoint.")
      .optional()
      .meta({ env: "GRAPHITI_TOKEN", helpDefault: false }),
    graphitiHome: graphitiText("Application-owned Graphiti runtime directory.")
      .optional()
      .meta({ env: "GRAPHITI_HOME" }),
    modelClass: ChatModelClassOptionSchema.default("chat-fast").meta({ env: "MODEL_CLASS" }),
    temperature: z.coerce
      .number<number>()
      .min(0)
      .max(2)
      .default(1)
      .describe("Sampling temperature forwarded to the Graphiti LLM client.")
      .meta({ env: "TEMPERATURE" }),
    structuredOutputMode: graphitiText(
      "Structured-output mode forwarded to Graphiti's OpenAI provider.",
    )
      .default("json_object")
      .meta({ env: "LLM_STRUCTURED_OUTPUT_MODE" }),
    startupTimeoutMs: z.coerce
      .number<number>()
      .int()
      .positive()
      .default(180_000)
      .describe("Maximum milliseconds allowed for the Graphiti runtime to become ready.")
      .meta({ env: "DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS" }),
    listen: options
      .listenAddressSchema({
        host: "127.0.0.1",
        loopback: true,
        port: 7272,
      })
      .describe("Graphiti HTTP listener.")
      .meta({ env: "GRAPHITI_LISTEN" }),
    databaseUrl: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("PostgreSQL URL or Lakebase target. Omit it to use persistent embedded PostgreSQL.")
      .meta({ env: ["LAKEBASE_ENDPOINT", "DATABASE_URL"], helpDefault: false }),
    databaseSchema: graphitiText("PostgreSQL schema used for Lakebase graph tables.")
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Database schema must be a PostgreSQL identifier.")
      .default("dbx_tools_graphiti")
      .meta({ env: "GRAPHITI_DATABASE_SCHEMA" }),
    ...options.PostgresOptionsSchema.shape,
  })
  .strict()
  .describe("Graphiti options accepted by Node, CLI, AppKit, and browser callers.");

/** Graphiti options represented as Commander flags. */
export const GraphitiCliOptionsSchema = GraphitiOptionsSchema.describe(
  "Graphiti options represented as Commander flags.",
);

export type GraphitiOptions = z.input<typeof GraphitiOptionsSchema>;

/** Defaults derived from the owning schema rather than maintained separately. */
export const GRAPHITI_DEFAULTS = Object.freeze(GraphitiOptionsSchema.parse({}));

const graphitiOptionKeys = Object.keys(GraphitiOptionsSchema.shape) as Array<
  keyof typeof GRAPHITI_DEFAULTS
>;

/** Keep only explicitly supplied Graphiti fields and validate their values. */
export function graphitiOptionOverrides(value: unknown): GraphitiOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Graphiti options must be an object");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const keys = graphitiOptionKeys.filter((key) => source[key] !== undefined);
  const parsed = GraphitiOptionsSchema.parse(
    Object.fromEntries(keys.map((key) => [key, source[key]])),
  );
  return Object.fromEntries(keys.map((key) => [key, parsed[key]])) as GraphitiOptions;
}

export const ResolvedGraphitiOptionsSchema = GraphitiOptionsSchema.describe(
  "Graphiti options after shared defaults are resolved.",
);

export type ResolvedGraphitiOptions = z.output<typeof ResolvedGraphitiOptionsSchema>;

/** Apply shared defaults and validate cross-runtime invariants. */
export function resolveGraphitiOptions(options: GraphitiOptions = {}): ResolvedGraphitiOptions {
  return ResolvedGraphitiOptionsSchema.parse(options);
}

/** Parse Graphiti option overrides from an explicit environment record. */
export function graphitiOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GraphitiOptions {
  return options.parseOpts(GraphitiOptionsSchema, null, environment);
}

/** Serialize one Graphiti configuration for the Python process environment. */
export function graphitiOptionsEnvironment(
  value: GraphitiOptions = {},
): Readonly<Record<string, string>> {
  return options.serializeOptsEnvironment(GraphitiOptionsSchema, value);
}
