/**
 * Browser-safe model-gateway routing contracts.
 *
 * @module
 */

import { model } from "@dbx-tools/shared-model";
import { z } from "zod";

export const ClientProtocolSchema = z
  .enum(["openai-responses", "openai-chat", "anthropic-messages", "openai-embeddings"])
  .describe("Client protocol accepted by the gateway.");

export type ClientProtocol = z.infer<typeof ClientProtocolSchema>;

export const UpstreamProtocolSchema = z
  .enum([
    "databricks-ai-gateway-codex",
    "databricks-responses",
    "databricks-open-responses",
    "databricks-chat",
    "databricks-anthropic",
    "databricks-embeddings",
    "ai-sdk",
  ])
  .describe("Upstream protocol selected by capability routing.");

export type UpstreamProtocol = z.infer<typeof UpstreamProtocolSchema>;

export const ModelCapabilitiesSchema = z
  .object({
    responses: z.boolean().describe("True when the model can serve the Databricks Responses API."),
    openResponses: z.boolean().describe("True when the model can serve OpenAI Responses."),
    chat: z.boolean().describe("True when the model can serve Chat Completions."),
    anthropic: z.boolean().describe("True when the model can serve Anthropic Messages."),
    embeddings: z.boolean().describe("True when the model can serve embeddings."),
    aiGatewayCodex: z
      .boolean()
      .describe("True when the model is reachable through AI Gateway Codex."),
    tools: z.boolean().describe("True when the model accepts tools."),
    reasoning: z.boolean().describe("True when the model accepts reasoning effort."),
    streaming: z.boolean().describe("True when the model can stream tokens."),
    parallelTools: z.boolean().describe("True when the model can run multiple tools in one turn."),
    customTools: z.boolean().describe("True when the model accepts custom tool definitions."),
    structuredOutput: z.boolean().describe("True when the model can return structured output."),
    webSearch: z.boolean().describe("True when the model can use web search."),
  })
  .describe("Capabilities used to determine whether a request can remain on a direct path.");

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelTargetSchema = z
  .object({
    id: z.string().min(1).describe("Canonical model id advertised by the gateway."),
    aliases: z.array(z.string().min(1)).describe("Additional names that resolve to this model."),
    displayName: z.string().min(1).describe("Human-readable label shown to clients."),
    family: z.string().optional().describe("Detected model family used for grouping."),
    modelServiceName: z
      .string()
      .optional()
      .describe("Canonical model-service name for metadata lookup."),
    endpoint: model.ServingEndpointSummarySchema.optional().describe(
      "Normalized serving endpoint backing this target, when discovered.",
    ),
    capabilities: ModelCapabilitiesSchema.describe(
      "Protocol and feature capabilities for this target.",
    ),
    reasoningEfforts: z
      .array(model.ReasoningEffortSchema)
      .describe("Reasoning effort values this target accepts."),
  })
  .describe("One discovered model plus every alias accepted by the gateway.");

export type ModelTarget = z.infer<typeof ModelTargetSchema>;

export const RequestedFeaturesSchema = z
  .object({
    background: z.boolean().describe("True when the client requested a background run."),
    customTools: z.boolean().describe("True when the request includes custom tools."),
    parallelTools: z.boolean().describe("True when the request asks for parallel tool calls."),
    previousResponse: z.boolean().describe("True when the request continues a stored response."),
    reasoning: z.boolean().describe("True when the request sets reasoning effort."),
    storage: z
      .boolean()
      .describe("True when the request asks the provider to persist the response."),
    structuredOutput: z.boolean().describe("True when the request requires structured output."),
    tools: z.boolean().describe("True when the request includes tools."),
    unsupportedOpenResponsesTools: z
      .boolean()
      .describe("True when tools cannot ride the Open Responses fast path."),
    webSearch: z.boolean().describe("True when the request includes web search."),
  })
  .describe("Request features that constrain direct protocol routes.");

export type RequestedFeatures = z.infer<typeof RequestedFeaturesSchema>;

export const GatewayRouteSchema = z
  .object({
    clientProtocol: ClientProtocolSchema.describe("Protocol the caller used."),
    upstreamProtocol: UpstreamProtocolSchema.describe("Protocol selected for the upstream call."),
    target: ModelTargetSchema.describe("Discovered model this request will invoke."),
    upstreamModel: z.string().min(1).describe("Model identifier sent to the upstream provider."),
    translateRequest: z.boolean().describe("True when the request body must be translated."),
    translateResponse: z.boolean().describe("True when the response body must be translated."),
  })
  .describe("Deterministic route selected for one gateway request.");

export type GatewayRoute = z.infer<typeof GatewayRouteSchema>;

export const ModelCapabilityOverrideSchema = z
  .object({
    model: z.string().min(1).describe("Model id or alias whose capabilities are overridden."),
    capabilities: ModelCapabilitiesSchema.partial().describe(
      "Capability flags to merge onto the discovered model.",
    ),
  })
  .describe("Typed capability changes for one dynamically discovered model.");

export type ModelCapabilityOverride = z.infer<typeof ModelCapabilityOverrideSchema>;

export const ResolveRouteInputSchema = z
  .object({
    clientProtocol: ClientProtocolSchema.describe("Protocol the caller used."),
    requestedModel: z.string().min(1).describe("Model id or alias requested by the caller."),
    originator: z.string().optional().describe("Optional Originator header, such as codex."),
    features: RequestedFeaturesSchema.describe("Request features that constrain routing."),
    target: ModelTargetSchema.describe("Discovered model selected for this request."),
  })
  .describe("Inputs required to select one deterministic gateway route.");

export type ResolveRouteInput = z.infer<typeof ResolveRouteInputSchema>;
