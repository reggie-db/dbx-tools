/**
 * Genie Code `config.toml` wire contract.
 *
 * @module
 */

import { z } from "zod";

export const GenieCodeModelProviderSchema = z
  .object({
    name: z.string().describe("Provider display name."),
    base_url: z.url().describe("OpenAI-compatible provider base URL."),
    wire_api: z.literal("responses").describe("Genie transport protocol."),
    requires_openai_auth: z.boolean().describe("Whether Genie must resolve OpenAI credentials."),
    supports_websockets: z.boolean().describe("Whether the provider accepts Responses WebSockets."),
    http_headers: z.record(z.string(), z.string()).describe("Static HTTP headers."),
  })
  .strict()
  .describe("One custom Genie Code model provider.");

export const GenieCodeBaseConfigSchema = z
  .object({
    databricks_profile: z.string().describe("Databricks profile represented by this home."),
    projects: z
      .record(
        z.string(),
        z.object({ trust_level: z.literal("trusted").describe("Project trust level.") }).strict(),
      )
      .describe("Trusted local projects keyed by absolute path."),
  })
  .strict()
  .describe("Persistent profile-scoped Genie Code configuration.");

export const GenieCodeProviderOverlaySchema = z
  .object({
    model_provider: z.string().describe("Selected provider identifier."),
    model: z.string().describe("Selected model name."),
    model_providers: z
      .record(z.string(), GenieCodeModelProviderSchema)
      .describe("Invocation-local model providers keyed by identifier."),
    tui: z
      .object({
        model_availability_nux: z
          .record(z.string(), z.literal(1))
          .describe("Models whose availability notice has been acknowledged."),
      })
      .strict()
      .describe("Invocation-specific Genie terminal UI settings."),
  })
  .strict()
  .describe("Invocation-specific Genie Code provider overlay.");

export const GenieCodeConfigSchema = GenieCodeBaseConfigSchema.extend({
  model_provider: GenieCodeProviderOverlaySchema.shape.model_provider,
  model: GenieCodeProviderOverlaySchema.shape.model,
  model_providers: GenieCodeProviderOverlaySchema.shape.model_providers,
  tui: GenieCodeProviderOverlaySchema.shape.tui,
}).describe("Merged persistent and invocation-specific Genie Code configuration.");

export type GenieCodeBaseConfig = z.infer<typeof GenieCodeBaseConfigSchema>;

export type GenieCodeProviderOverlay = z.infer<typeof GenieCodeProviderOverlaySchema>;

export type GenieCodeConfig = z.infer<typeof GenieCodeConfigSchema>;
