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

export const ModelGatewayOptionsSchema = ModelSelectionOptionsSchema.safeExtend({
  smartRouter: SmartRouterModeSchema.default("auto"),
  smartRouterTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(10_000)
    .describe("Maximum milliseconds allowed for one Databricks Smart Router request."),
  smartRouterContextTokenBudget: z
    .number()
    .int()
    .min(256)
    .max(32_768)
    .default(4_096)
    .describe("o200k_base token budget used to build Smart Router task context."),
  smartRouterProbeTtlMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000)
    .describe("Milliseconds a successful memoized Smart Router capability probe remains valid."),
  smartRouterProbeRefreshIntervalMs: z
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000)
    .describe("Milliseconds between unref'd background refreshes of cached Smart Router probes."),
  smartRouterRouteTtlSeconds: z
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(21_600)
    .describe("Seconds a logical turn remains pinned to its Smart Router-selected model."),
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
})
  .strict()
  .describe("Model-gateway server configuration.");

export const ModelGatewayCliOptionsSchema = ModelGatewayOptionsSchema.safeExtend({
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
