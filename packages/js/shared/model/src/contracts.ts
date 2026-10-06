/**
 * Browser-safe Zod model contracts shared across dbx-tools runtimes.
 *
 * This module is the single owner for model wire validation and TypeScript
 * types. Define schemas here and derive exported types with `z.infer`; do not
 * maintain parallel interfaces or generated schema mirrors.
 *
 * @module
 */

import { z } from "zod";

export const ModelClassSchema = z
  .enum(["chat-thinking", "chat-balanced", "chat-fast", "embedding"])
  .describe("Intent-oriented Databricks Model Serving endpoint class.");

export type ModelClass = z.infer<typeof ModelClassSchema>;

/** Named runtime values for the model class contract. */
export const ModelClass = {
  ChatThinking: "chat-thinking",
  ChatBalanced: "chat-balanced",
  ChatFast: "chat-fast",
  Embedding: "embedding",
} as const satisfies Record<string, ModelClass>;

export const ReasoningEffortSchema = z
  .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  .describe("Reasoning effort value accepted by compatible model endpoints.");

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** Named runtime values for the reasoning effort contract. */
export const ReasoningEffort = {
  None: "none",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const satisfies Record<string, ReasoningEffort>;

/** Existing public name for reasoning effort runtime values. */
export const ReasoningEffortValues = ReasoningEffort;

export const ModelProfileSchema = z
  .object({
    quality: z.number().optional().describe("Relative quality score for ranking."),
    speed: z.number().optional().describe("Relative speed score for ranking."),
    cost: z.number().optional().describe("Relative cost score for ranking."),
  })
  .describe("Relative quality, speed, and cost scores for an endpoint.");

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelStatusSchema = z
  .object({
    deprecated: z
      .boolean()
      .default(false)
      .describe("True when the model should no longer be selected by default."),
  })
  .describe("Model retirement status.");

export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const ServingEndpointSummarySchema = z
  .object({
    name: z.string().describe("Serving endpoint invoke id."),
    displayName: z
      .string()
      .optional()
      .describe("Human-readable label when the workspace provides one."),
    family: z
      .string()
      .optional()
      .describe("Detected model family used for grouping and sort order."),
    task: z.string().optional().describe("Databricks serving task reported for the endpoint."),
    state: z.string().optional().describe("Serving endpoint lifecycle state."),
    description: z.string().optional().describe("Workspace-provided endpoint description."),
    supportsTools: z.boolean().optional().describe("True when the endpoint accepts tool calls."),
    profile: ModelProfileSchema.optional().describe("Relative quality, speed, and cost scores."),
    class: ModelClassSchema.optional().describe("Intent-oriented class assigned to this endpoint."),
    serviceNames: z
      .record(z.string(), z.string())
      .optional()
      .describe("Provider-specific service name aliases keyed by protocol."),
    modelServiceName: z
      .string()
      .optional()
      .describe("Canonical model-service name used for metadata lookup."),
    reasoningEfforts: z
      .array(ReasoningEffortSchema)
      .optional()
      .describe("Reasoning effort values this endpoint accepts."),
    status: ModelStatusSchema.optional().describe("Retirement status for this endpoint."),
    dimension: z
      .number()
      .optional()
      .describe("Embedding vector size when the endpoint is an embedding model."),
  })
  .describe("Browser-safe normalized Model Serving endpoint metadata.");

export type ServingEndpointSummary = z.infer<typeof ServingEndpointSummarySchema>;

export const ModelQuerySchema = z
  .object({
    name: z.string().optional().describe("Exact serving endpoint name to retain."),
    search: z
      .string()
      .optional()
      .describe("Free-text query matched against endpoint names and labels."),
    modelClass: ModelClassSchema.optional().describe(
      "Restrict results to this intent-oriented class.",
    ),
    requiresTools: z
      .boolean()
      .optional()
      .describe("When true, only endpoints that accept tools are returned."),
    task: z.string().optional().describe("Exact Databricks serving task to retain."),
    dimension: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Exact embedding vector dimension to retain."),
    minDimension: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Minimum embedding vector dimension to retain."),
    maxDimension: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum embedding vector dimension to retain."),
    reasoningEffort: ReasoningEffortSchema.optional().describe(
      "Reasoning effort that a retained endpoint must accept.",
    ),
    includeDeprecated: z
      .boolean()
      .optional()
      .describe("When true, retired endpoints remain in the result set."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum number of ranked results to return."),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum fuzzy-match score in the range 0 to 1."),
  })
  .describe("Browser-safe model catalogue search and ranking controls.");

export type ModelQuery = z.infer<typeof ModelQuerySchema>;

export const RankedModelSchema = z
  .object({
    endpoint: ServingEndpointSummarySchema.describe("Normalized endpoint chosen for this result."),
    modelClass: ModelClassSchema.describe("Class used to rank this result."),
    score: z.number().min(0).max(1).optional().describe("Fuzzy-match score in the range 0 to 1."),
  })
  .describe("One ranked model-search result.");

export type RankedModel = z.infer<typeof RankedModelSchema>;

export const EndpointCapabilitiesSchema = z
  .object({
    chat: z.boolean().describe("True when the endpoint can serve chat completions."),
    embedding: z.boolean().describe("True when the endpoint can serve embeddings."),
    tools: z.boolean().describe("True when the endpoint accepts tool calls."),
  })
  .describe("Capabilities derived from one normalized serving endpoint.");

export type EndpointCapabilities = z.infer<typeof EndpointCapabilitiesSchema>;

export const FamilyClassSchema = z
  .object({
    class: ModelClassSchema.describe("Fallback class for an unscored recognized family."),
    rank: z.number().min(0).describe("Relative rank among family fallbacks, starting at 0."),
  })
  .describe("Fallback class and rank for an unscored recognized model family.");

export type FamilyClass = z.infer<typeof FamilyClassSchema>;

export const ModelCapabilitiesSchema = z
  .object({
    responses: z.boolean().describe("True when the model supports the Responses API."),
    imageInput: z.boolean().describe("True when the model accepts image inputs."),
    applyPatch: z.boolean().describe("True when the model supports the apply-patch tool."),
    webSearch: z.boolean().describe("True when the model supports web search."),
  })
  .describe("Documented capabilities resolved for one model identity.");

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelRateLimitsSchema = z
  .object({
    inputTokensPerMinute: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Published input tokens per minute, or null when unpublished."),
    outputTokensPerMinute: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Published output tokens per minute, or null when unpublished."),
    queriesPerHour: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Published queries per hour, or null when unpublished."),
  })
  .describe("Published pay-per-token limits for one model.");

export type ModelRateLimits = z.infer<typeof ModelRateLimitsSchema>;

export const ModelMetadataSchema = z
  .object({
    status: ModelStatusSchema.describe("Retirement status for this model identity."),
    capabilities: ModelCapabilitiesSchema.describe(
      "Documented capabilities for this model identity.",
    ),
    rateLimits: ModelRateLimitsSchema.optional().describe("Published rate limits when available."),
  })
  .describe("Combined retirement, capability, and rate-limit metadata.");

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export const ResolvedModelSchema = z
  .object({
    modelId: z.string().describe("Resolved serving endpoint or model identifier."),
    matched: z.boolean().describe("True when the identifier matched a catalogue entry."),
    score: z.number().min(0).max(1).optional().describe("Fuzzy-match score in the range 0 to 1."),
  })
  .describe("Result of resolving a fuzzy model identifier.");

export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const ResolveModelOptionsSchema = z
  .object({
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum fuzzy-match score in the range 0 to 1."),
    requiresTools: z
      .boolean()
      .optional()
      .describe("When true, only tool-capable endpoints may match."),
  })
  .describe("Pure controls for fuzzy endpoint resolution.");

export type ResolveModelOptions = z.infer<typeof ResolveModelOptionsSchema>;

export const ScoredEndpointSchema = z
  .object({
    endpoint: ServingEndpointSummarySchema.describe("Candidate serving endpoint."),
    score: z.number().min(0).max(1).describe("Fuzzy-match distance in the range 0 to 1."),
  })
  .describe("One endpoint paired with its fuzzy-match distance.");

export type ScoredEndpoint = z.infer<typeof ScoredEndpointSchema>;

export const ResolveModelInputSchema = z
  .object({
    explicit: z
      .string()
      .optional()
      .describe("Exact model id or display name supplied by the caller."),
    fuzzy: z.boolean().optional().describe("When true, unmatched explicit values may fuzzy-match."),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum fuzzy-match score in the range 0 to 1."),
    requiresTools: z
      .boolean()
      .optional()
      .describe("When true, only tool-capable endpoints may be selected."),
    modelClass: ModelClassSchema.optional().describe(
      "Preferred intent-oriented class when no explicit model matches.",
    ),
    fallbacks: z
      .array(z.string())
      .optional()
      .describe("Ordered model ids tried after class selection fails."),
    liveOnly: z
      .boolean()
      .optional()
      .describe("When true, skip endpoints that are not currently ready."),
  })
  .describe("Caller intent used to resolve one model from a catalogue.");

export type ResolveModelInput = z.infer<typeof ResolveModelInputSchema>;

export const ResolvedModelSelectionSchema = z
  .object({
    modelId: z.string().describe("Selected serving endpoint identifier."),
    source: z
      .enum(["explicit", "fuzzy-match", "class", "fallback"])
      .describe("Policy branch that selected this model."),
  })
  .describe("Selected model identifier and the policy branch that selected it.");

export type ResolvedModelSelection = z.infer<typeof ResolvedModelSelectionSchema>;
