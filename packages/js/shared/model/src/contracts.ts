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

export const AutomaticRouteTierSchema = z
  .enum(["fast", "balanced", "thinking"])
  .describe("Logical model capability tier selected for an automatic chat turn.");

export type AutomaticRouteTier = z.infer<typeof AutomaticRouteTierSchema>;

export const AutomaticRouteReasonCodeSchema = z
  .enum([
    "short_response",
    "extraction",
    "routine_qa",
    "tool_use",
    "research",
    "debugging",
    "code_change",
    "large_refactor",
    "long_context",
    "ambiguous",
  ])
  .describe("Bounded explanation category for an automatic route decision.");

export type AutomaticRouteReasonCode = z.infer<typeof AutomaticRouteReasonCodeSchema>;

export const AutomaticRouteDecisionSourceSchema = z
  .enum(["selector", "heuristic", "cache", "fallback"])
  .describe("Runtime source that produced an automatic route decision.");

export type AutomaticRouteDecisionSource = z.infer<typeof AutomaticRouteDecisionSourceSchema>;

export const AutomaticRouteDecisionSchema = z
  .object({
    tier: AutomaticRouteTierSchema.describe("Logical model tier selected for the turn."),
    reasoningEffort: ReasoningEffortSchema.describe(
      "Generic reasoning budget selected for the turn.",
    ),
    confidence: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .describe("Selector confidence in the range zero through one."),
    reasonCode: AutomaticRouteReasonCodeSchema.describe(
      "Bounded reason category for the selected route.",
    ),
  })
  .strict()
  .describe("Validated selector decision before resolving a concrete model.");

export type AutomaticRouteDecision = z.infer<typeof AutomaticRouteDecisionSchema>;

export const AutomaticRouteFeaturesSchema = z
  .object({
    tools: z.boolean().describe("True when the request includes callable tools."),
    webSearch: z.boolean().describe("True when the request includes web search."),
    imageInput: z.boolean().describe("True when the request includes image input."),
    structuredOutput: z.boolean().describe("True when structured output is required."),
    applyPatch: z.boolean().describe("True when the request includes an apply-patch tool."),
  })
  .strict()
  .describe("Hard request features summarized for automatic routing.");

export type AutomaticRouteFeatures = z.infer<typeof AutomaticRouteFeaturesSchema>;

export const AutomaticRouteRequestSchema = z
  .object({
    protocol: z
      .enum(["openai-responses", "openai-chat", "anthropic-messages"])
      .describe("Client chat protocol used for this request."),
    currentRequest: z.string().describe("Token-budgeted text of the latest user request."),
    recentContext: z
      .array(z.string())
      .describe("Token-budgeted recent user and assistant messages before the latest request."),
    toolNames: z
      .array(z.string().min(1).max(200))
      .max(64)
      .describe("Tool names without schemas, arguments, or implementation details."),
    inputCharacters: z
      .number()
      .int()
      .nonnegative()
      .describe("Approximate text size supplied to the model request."),
    selectorTokens: z
      .number()
      .int()
      .nonnegative()
      .describe("o200k_base tokens retained in currentRequest and recentContext."),
    continuation: z
      .boolean()
      .describe("True when assistant or tool events follow the latest user message."),
    features: AutomaticRouteFeaturesSchema.describe(
      "Hard request features the selected model must satisfy.",
    ),
    eligibleTiers: z
      .array(AutomaticRouteTierSchema)
      .min(1)
      .max(3)
      .describe("Logical tiers that still have at least one compatible live model."),
  })
  .strict()
  .describe(
    "Bounded routing state that excludes transport credentials, tool arguments, and binary data.",
  );

export type AutomaticRouteRequest = z.infer<typeof AutomaticRouteRequestSchema>;

export const AutomaticRouteObservationSchema = z
  .object({
    selectedModel: z.string().min(1).describe("Concrete model selected for the turn."),
    tier: AutomaticRouteTierSchema.describe("Resolved logical tier of the selected model."),
    reasoningEffort: ReasoningEffortSchema.optional().describe(
      "Generic reasoning effort applied to the selected model when supported.",
    ),
    confidence: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .describe("Confidence attached to the accepted route decision."),
    reasonCode: AutomaticRouteReasonCodeSchema.describe(
      "Bounded reason category attached to the accepted route.",
    ),
    source: AutomaticRouteDecisionSourceSchema.describe(
      "Runtime source that produced or recovered the decision.",
    ),
    degraded: z
      .boolean()
      .describe("True when selector failure or low confidence forced fallback policy."),
    selectorModel: z
      .string()
      .optional()
      .describe("System One selector model used for the decision, when called."),
    selectorLatencyMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Elapsed selector request time in milliseconds, when called."),
  })
  .strict()
  .describe("Persistable and observable result of automatic model routing.");

export type AutomaticRouteObservation = z.infer<typeof AutomaticRouteObservationSchema>;

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
    reasoning: z.boolean().describe("True when the model supports explicit reasoning controls."),
    tools: z.boolean().describe("True when the model supports tool calling."),
    structuredOutput: z.boolean().describe("True when the model supports structured output."),
    temperature: z.boolean().describe("True when the model accepts temperature sampling."),
  })
  .describe("Published capabilities resolved for one model identity.");

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
      "Published capabilities for this model identity.",
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
