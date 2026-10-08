/**
 * Browser-safe model-gateway runtime and CLI configuration.
 *
 * Field names and descriptions are the single source for derived Commander
 * flags, environment names, generated help, JavaScript callers, and services.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

export const ModelGatewayOptionsSchema = z
  .object({
    listen: options
      .listenAddressSchema({ port: 4000, loopback: true })
      .describe("Loopback listener address."),
    profile: options.DatabricksOptionsSchema.shape.profile.describe(
      "Databricks profile used for model discovery and requests.",
    ),
    bodyLimit: z
      .string()
      .trim()
      .min(1)
      .default("100mb")
      .describe("Maximum JSON request body size."),
    bearerToken: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional bearer token required by every gateway route.")
      .meta({
        env: "DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN",
        flag: false,
        helpDefault: false,
      }),
  })
  .strict()
  .describe("Model-gateway server configuration.");

export const ModelGatewayCliOptionsSchema = ModelGatewayOptionsSchema.extend({
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
