/**
 * Browser-safe model-gateway runtime and CLI configuration.
 *
 * Field names and descriptions are the single source for derived Commander
 * flags, environment names, generated help, JavaScript callers, and services.
 *
 * @module
 */

import { listenAddressSchema, DatabricksOptionsSchema } from "@dbx-tools/shared-core";
import { ModelClassSchema } from "@dbx-tools/shared-model";
import { z } from "zod";

const SMART_ROUTER_TIMEOUT_MS_DEFAULT = 10_000;
const SMART_ROUTER_CONTEXT_TOKEN_BUDGET_DEFAULT = 4_096;
const SMART_ROUTER_PROBE_TTL_MS_DEFAULT = 300_000;
const SMART_ROUTER_PROBE_REFRESH_INTERVAL_MS_DEFAULT = 3_600_000;
const SMART_ROUTER_ROUTE_TTL_SECONDS_DEFAULT = 21_600;

const SmartRouterTimeoutMsSchema = z
  .number()
  .int()
  .min(100)
  .max(60_000)
  .describe("Maximum milliseconds allowed for one Databricks Smart Router request.");

const SmartRouterContextTokenBudgetSchema = z
  .number()
  .int()
  .min(256)
  .max(32_768)
  .describe("o200k_base token budget used to build Smart Router task context.");

const SmartRouterProbeTtlMsSchema = z
  .number()
  .int()
  .min(1_000)
  .max(3_600_000)
  .describe("Milliseconds a successful memoized Smart Router capability probe remains valid.");

const SmartRouterProbeRefreshIntervalMsSchema = z
  .number()
  .int()
  .min(60_000)
  .max(86_400_000)
  .describe("Milliseconds between unref'd background refreshes of cached Smart Router probes.");

const SmartRouterRouteTtlSecondsSchema = z
  .number()
  .int()
  .min(60)
  .max(86_400)
  .describe("Seconds a logical turn remains pinned to its Smart Router-selected model.");

export const ModelOptionSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Optional fuzzy or exact model name.");

export const ModelClassOptionSchema = ModelClassSchema.optional().describe(
  "Optional model capability class used when selecting a default model.",
);

export const ChatModelClassOptionSchema = ModelClassSchema.exclude(["embedding"])
  .optional()
  .describe("Optional chat capability class used when selecting a default model.");

export const ModelSelectionOptionsSchema = z
  .object({
    model: ModelOptionSchema,
    modelClass: ModelClassOptionSchema,
  })
  .refine((options) => !(options.model && options.modelClass), {
    message: "Model and model class are mutually exclusive.",
    path: ["modelClass"],
  })
  .describe("Model selection by name or capability class.");

export const ChatModelSelectionOptionsSchema = ModelSelectionOptionsSchema.safeExtend({
  modelClass: ChatModelClassOptionSchema,
}).describe("Chat-model selection by name or capability class.");

export const SmartRouterModeSchema = z
  .enum(["auto", "true", "false"])
  .describe(
    "Smart Router mode: auto advertises it only when available, true requires it, and false disables it.",
  );

const ModelGatewayRuntimeOptionsShape = {
  smartRouter: SmartRouterModeSchema.default("auto"),
  smartRouterTimeoutMs: SmartRouterTimeoutMsSchema.default(SMART_ROUTER_TIMEOUT_MS_DEFAULT),
  smartRouterContextTokenBudget: SmartRouterContextTokenBudgetSchema.default(
    SMART_ROUTER_CONTEXT_TOKEN_BUDGET_DEFAULT,
  ),
  smartRouterProbeTtlMs: SmartRouterProbeTtlMsSchema.default(SMART_ROUTER_PROBE_TTL_MS_DEFAULT),
  smartRouterProbeRefreshIntervalMs: SmartRouterProbeRefreshIntervalMsSchema.default(
    SMART_ROUTER_PROBE_REFRESH_INTERVAL_MS_DEFAULT,
  ),
  smartRouterRouteTtlSeconds: SmartRouterRouteTtlSecondsSchema.default(
    SMART_ROUTER_ROUTE_TTL_SECONDS_DEFAULT,
  ),
  preferSystemModels: z
    .boolean()
    .default(false)
    .describe("Prefer system.ai services over serving endpoints for non-exact model selection."),
  listen: listenAddressSchema({ port: 4000, loopback: true }).describe(
    "Loopback listener address.",
  ),
  profile: DatabricksOptionsSchema.shape.profile.describe(
    "Databricks profile used for model discovery and requests.",
  ),
  bodyLimit: z.string().trim().min(1).default("100mb").describe("Maximum JSON request body size."),
  bearerToken: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional bearer token required by every gateway route.")
    .meta({
      env: "MODEL_GATEWAY_BEARER_TOKEN",
      flag: false,
      helpDefault: false,
    }),
};

export const ModelGatewayOptionsSchema = ModelSelectionOptionsSchema.safeExtend(
  ModelGatewayRuntimeOptionsShape,
)
  .strict()
  .describe("Model-gateway server configuration.");

export const ModelGatewayCliOptionsSchema = ModelSelectionOptionsSchema.safeExtend({
  ...ModelGatewayRuntimeOptionsShape,
  smartRouterTimeoutMs: z.coerce
    .number()
    .pipe(SmartRouterTimeoutMsSchema)
    .default(SMART_ROUTER_TIMEOUT_MS_DEFAULT),
  smartRouterContextTokenBudget: z.coerce
    .number()
    .pipe(SmartRouterContextTokenBudgetSchema)
    .default(SMART_ROUTER_CONTEXT_TOKEN_BUDGET_DEFAULT),
  smartRouterProbeTtlMs: z.coerce
    .number()
    .pipe(SmartRouterProbeTtlMsSchema)
    .default(SMART_ROUTER_PROBE_TTL_MS_DEFAULT),
  smartRouterProbeRefreshIntervalMs: z.coerce
    .number()
    .pipe(SmartRouterProbeRefreshIntervalMsSchema)
    .default(SMART_ROUTER_PROBE_REFRESH_INTERVAL_MS_DEFAULT),
  smartRouterRouteTtlSeconds: z.coerce
    .number()
    .pipe(SmartRouterRouteTtlSecondsSchema)
    .default(SMART_ROUTER_ROUTE_TTL_SECONDS_DEFAULT),
  runtimeInfo: z.boolean().default(false).describe("Print runtime implementation metadata."),
  selectModelFrom: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Select a Smart Router model from a JSON or text file; use - for standard input."),
})
  .refine((options) => options.listen.port > 0, {
    message: "Port must be an integer from 1 through 65535.",
    path: ["listen"],
  })
  .describe("Model-gateway command-line configuration.");

export type ModelGatewayOptions = z.input<typeof ModelGatewayOptionsSchema>;

export type ResolvedModelGatewayOptions = z.output<typeof ModelGatewayOptionsSchema>;

export type ModelGatewayCliOptions = z.output<typeof ModelGatewayCliOptionsSchema>;

export type SmartRouterMode = z.infer<typeof SmartRouterModeSchema>;

/** Defaults parsed from the owning runtime schema. */
export const MODEL_GATEWAY_DEFAULTS = Object.freeze(ModelGatewayOptionsSchema.parse({}));

/** Validate and default model-gateway server options. */
export function resolveModelGatewayOptions(
  options: ModelGatewayOptions = {},
): ResolvedModelGatewayOptions {
  return ModelGatewayOptionsSchema.parse(options);
}

/** Validate and default model-gateway command-line options. */
export function resolveModelGatewayCliOptions(options: unknown): ModelGatewayCliOptions {
  return ModelGatewayCliOptionsSchema.parse(options);
}
