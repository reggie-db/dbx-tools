/**
 * Browser-safe Graphiti configuration shared by every runtime.
 *
 * This module owns the Graphiti option schema, defaults, environment mapping,
 * and derived gateway settings. CLIs, AppKit integrations, and generated
 * bindings should pass this configuration through rather than recreating it.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

/** Environment variable carrying one serialized {@link GraphitiOptions} object. */
export const GRAPHITI_OPTIONS_ENV = "DBX_GRAPHITI_OPTIONS";

/** Environment variable selecting the internal Python runtime operation. */
export const GRAPHITI_COMMAND_ENV = "DBX_GRAPHITI_COMMAND";

export const GraphitiCommandSchema = z
  .enum(["start", "up", "down", "status", "env"])
  .describe("Operations accepted by the internal Graphiti Python runtime.");

export type GraphitiCommand = z.infer<typeof GraphitiCommandSchema>;

const graphitiText = (description: string) => z.string().trim().min(1).describe(description);
const graphitiPort = (description: string) => options.tcpPortOrZeroSchema.describe(description);

export const GraphitiOptionsSchema = z
  .object({
    python: graphitiText("Python executable used to run the matching Graphiti package.").default(
      "python3",
    ),
    profile: options.DatabricksOptionsSchema.shape.profile.describe(
      "Databricks profile used for model discovery, authentication, and persistence.",
    ),
    graphitiHome: graphitiText("Application-owned Graphiti runtime directory.").optional(),
    model: graphitiText("Fuzzy chat-model name or endpoint identifier.")
      .default("databricks-gpt-5-nano")
      .meta({ env: "MODEL_NAME" }),
    embedderModel: graphitiText("Fuzzy embedding-model name or endpoint identifier.").default(
      "databricks-gte-large-en",
    ),
    embedderDimensions: z.coerce
      .number<number>()
      .int()
      .positive()
      .default(1024)
      .describe("Embedding vector dimensions expected by Graphiti."),
    modelGatewayUrl: options.normalizedUrlSchema
      .optional()
      .describe("Existing OpenAI-compatible model gateway base URL, including /v1.")
      .meta({ env: ["MODEL_GATEWAY_URL", "OPENAI_API_URL"] }),
    modelGatewayHost: graphitiText("Listener host for a locally managed model gateway.").default(
      "127.0.0.1",
    ),
    modelGatewayPort: graphitiPort("Listener port for a locally managed model gateway.").default(
      4400,
    ),
    modelGatewayCommand: graphitiText(
      "Command used to start a locally managed model gateway.",
    ).optional(),
    manageModelGateway: z
      .boolean()
      .optional()
      .describe("Whether Graphiti starts and stops a local model gateway."),
    openAiApiKey: graphitiText(
      "API key used only with an externally managed OpenAI-compatible endpoint.",
    )
      .optional()
      .meta({ env: "OPENAI_API_KEY" }),
    structuredOutputMode: graphitiText(
      "Structured-output mode forwarded to Graphiti's OpenAI provider.",
    )
      .default("json_object")
      .meta({ env: "LLM_STRUCTURED_OUTPUT_MODE" }),
    graphitiHost: graphitiText("Graphiti MCP listener host.").default("127.0.0.1"),
    graphitiPort: graphitiPort("Graphiti MCP listener port.").default(8000),
    proxyPort: graphitiPort("AppKit reverse-proxy listener port.").default(0),
    journalNamespace: graphitiText(
      "Persistence namespace used by the Graphiti write journal.",
    ).optional(),
    journalDatabaseUrl: graphitiText("Explicit PostgreSQL journal URL.").optional(),
    journalTable: graphitiText("PostgreSQL journal table name.").optional(),
    graphitiArgs: z
      .array(z.string())
      .default([])
      .describe("Arguments forwarded to the pinned upstream Graphiti MCP server."),
  })
  .strict()
  .describe("Graphiti options accepted by JavaScript, Python, and generated bindings.");

/** Graphiti options represented as Commander flags rather than positional arguments. */
export const GraphitiCliOptionsSchema = GraphitiOptionsSchema.omit({ graphitiArgs: true }).describe(
  "Graphiti options represented as Commander flags rather than positional arguments.",
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

export const ResolvedGraphitiOptionsSchema = GraphitiOptionsSchema.transform((options, context) => {
  const manageModelGateway = options.manageModelGateway ?? options.modelGatewayUrl === undefined;
  const modelGatewayUrl = (
    options.modelGatewayUrl ?? `http://${options.modelGatewayHost}:${options.modelGatewayPort}/v1`
  ).replace(/\/$/, "");
  if (options.graphitiPort && options.proxyPort && options.graphitiPort === options.proxyPort) {
    context.addIssue({
      code: "custom",
      message: "graphitiPort and proxyPort must be distinct",
      path: ["proxyPort"],
    });
  }
  return {
    ...options,
    modelGatewayUrl,
    manageModelGateway,
    openAiApiKey: options.openAiApiKey ?? "not-required",
  };
}).describe("Graphiti options after defaults and gateway ownership are resolved.");

export type ResolvedGraphitiOptions = z.output<typeof ResolvedGraphitiOptionsSchema>;

/** Apply shared defaults and validate cross-runtime invariants. */
export function resolveGraphitiOptions(options: GraphitiOptions = {}): ResolvedGraphitiOptions {
  return ResolvedGraphitiOptionsSchema.parse(options);
}

/** Serialize resolved options for the internal Python runtime boundary. */
export function serializeGraphitiOptions(options: GraphitiOptions = {}): string {
  return JSON.stringify(resolveGraphitiOptions(options));
}

/** Parse Graphiti option overrides from an explicit environment record. */
export function graphitiOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GraphitiOptions {
  return options.parseOptionOverrides(GraphitiOptionsSchema, null, environment);
}

/** Return the managed model gateway health endpoint. */
export function graphitiGatewayHealthUrl(options: GraphitiOptions = {}): string {
  return `${resolveGraphitiOptions(options).modelGatewayUrl.replace(/\/v1$/, "")}/api/healthz`;
}

/** Return Graphiti provider environment variables from resolved shared options. */
export function graphitiEnvironment(options: GraphitiOptions = {}): Record<string, string> {
  const resolved = resolveGraphitiOptions(options);
  return {
    OPENAI_API_URL: resolved.modelGatewayUrl,
    OPENAI_API_KEY: resolved.openAiApiKey,
    LLM__PROVIDERS__OPENAI__API_URL: resolved.modelGatewayUrl,
    LLM__PROVIDERS__OPENAI__API_KEY: resolved.openAiApiKey,
    MODEL_NAME: resolved.model,
    EMBEDDER_MODEL: resolved.embedderModel,
    EMBEDDER__PROVIDERS__OPENAI__API_URL: resolved.modelGatewayUrl,
    EMBEDDER__PROVIDERS__OPENAI__API_KEY: resolved.openAiApiKey,
    EMBEDDER_DIMENSIONS: String(resolved.embedderDimensions),
    EMBEDDER__DIMENSIONS: String(resolved.embedderDimensions),
    EMBEDDING_DIM: String(resolved.embedderDimensions),
    LLM_STRUCTURED_OUTPUT_MODE: resolved.structuredOutputMode,
  };
}
