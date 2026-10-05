/**
 * Browser-safe model-gateway routing contracts.
 *
 * @module
 */

import { model } from "@dbx-tools/shared-model";
import { z } from "zod";

/** Client protocol accepted by the gateway. */
export const ClientProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "openai-embeddings",
]);
/** Client protocol accepted by the gateway. */
export type ClientProtocol = z.infer<typeof ClientProtocolSchema>;

/** Upstream protocol selected by capability routing. */
export const UpstreamProtocolSchema = z.enum([
  "databricks-ai-gateway-codex",
  "databricks-responses",
  "databricks-open-responses",
  "databricks-chat",
  "databricks-anthropic",
  "databricks-embeddings",
  "ai-sdk",
]);
/** Upstream protocol selected by capability routing. */
export type UpstreamProtocol = z.infer<typeof UpstreamProtocolSchema>;

/** Capabilities used to determine whether a request can remain on a direct path. */
export const ModelCapabilitiesSchema = z.object({
  responses: z.boolean(),
  openResponses: z.boolean(),
  chat: z.boolean(),
  anthropic: z.boolean(),
  embeddings: z.boolean(),
  aiGatewayCodex: z.boolean(),
  tools: z.boolean(),
  reasoning: z.boolean(),
  streaming: z.boolean(),
  parallelTools: z.boolean(),
  customTools: z.boolean(),
  structuredOutput: z.boolean(),
  webSearch: z.boolean(),
});
/** Capabilities used to determine whether a request can remain on a direct path. */
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/** One discovered model plus every alias accepted by the gateway. */
export const ModelTargetSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  displayName: z.string().min(1),
  family: z.string().optional(),
  modelServiceName: z.string().optional(),
  endpoint: model.ServingEndpointSummarySchema.optional(),
  capabilities: ModelCapabilitiesSchema,
  reasoningEfforts: z.array(model.ReasoningEffortSchema),
});
/** One discovered model plus every alias accepted by the gateway. */
export type ModelTarget = z.infer<typeof ModelTargetSchema>;

/** Request features that constrain direct protocol routes. */
export const RequestedFeaturesSchema = z.object({
  background: z.boolean(),
  customTools: z.boolean(),
  parallelTools: z.boolean(),
  previousResponse: z.boolean(),
  reasoning: z.boolean(),
  storage: z.boolean(),
  structuredOutput: z.boolean(),
  tools: z.boolean(),
  unsupportedOpenResponsesTools: z.boolean(),
  webSearch: z.boolean(),
});
/** Request features that constrain direct protocol routes. */
export type RequestedFeatures = z.infer<typeof RequestedFeaturesSchema>;

/** Deterministic route selected for one gateway request. */
export const GatewayRouteSchema = z.object({
  clientProtocol: ClientProtocolSchema,
  upstreamProtocol: UpstreamProtocolSchema,
  target: ModelTargetSchema,
  upstreamModel: z.string().min(1),
  translateRequest: z.boolean(),
  translateResponse: z.boolean(),
});
/** Deterministic route selected for one gateway request. */
export type GatewayRoute = z.infer<typeof GatewayRouteSchema>;

/** Typed capability changes for one dynamically discovered model. */
export const ModelCapabilityOverrideSchema = z.object({
  model: z.string().min(1),
  capabilities: ModelCapabilitiesSchema.partial(),
});
/** Typed capability changes for one dynamically discovered model. */
export type ModelCapabilityOverride = z.infer<typeof ModelCapabilityOverrideSchema>;

/** Inputs required to select one deterministic gateway route. */
export const ResolveRouteInputSchema = z.object({
  clientProtocol: ClientProtocolSchema,
  requestedModel: z.string().min(1),
  originator: z.string().optional(),
  features: RequestedFeaturesSchema,
  target: ModelTargetSchema,
});
/** Inputs required to select one deterministic gateway route. */
export type ResolveRouteInput = z.infer<typeof ResolveRouteInputSchema>;
