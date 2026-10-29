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

export const ModelGatewayOptionsSchema = ModelSelectionOptionsSchema.safeExtend({
  automaticRouting: z
    .boolean()
    .default(true)
    .describe("Expose model auto and route each top-level chat turn by request complexity."),
  automaticSelectorModel: z
    .string()
    .trim()
    .min(1)
    .default("system.ai.openjev-qwen3.5-4b")
    .describe("System One model used to classify automatic chat requests."),
  automaticSelectorTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(2_000)
    .describe("Maximum milliseconds allowed for one System One routing decision."),
  automaticSelectorTokenBudget: z
    .number()
    .int()
    .min(256)
    .max(32_768)
    .default(4_096)
    .describe("o200k_base token budget for the current request and recent chat context."),
  automaticMinimumConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.55)
    .describe("Minimum System One confidence accepted before deterministic fallback."),
  automaticRouteTtlSeconds: z
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(21_600)
    .describe("Seconds a logical turn keeps its selected concrete model and reasoning effort."),
  automaticPreferCostEfficientModels: z
    .boolean()
    .default(true)
    .describe(
      "Within the selected tier, prefer lower-cost profiles and then recognized open-weight models.",
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
})
  .strict()
  .describe("Model-gateway server configuration.");

export const ModelGatewayCliOptionsSchema = ModelGatewayOptionsSchema.safeExtend({
  runtimeInfo: z.boolean().default(false).describe("Print runtime implementation metadata."),
})
  .refine((options) => options.listen.port > 0, {
    message: "Port must be an integer from 1 through 65535.",
    path: ["listen"],
  })
  .describe("Model-gateway command-line configuration.");

export type ModelGatewayOptions = z.input<typeof ModelGatewayOptionsSchema>;

export type ResolvedModelGatewayOptions = z.output<typeof ModelGatewayOptionsSchema>;

export type ModelGatewayCliOptions = z.output<typeof ModelGatewayCliOptionsSchema>;

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
