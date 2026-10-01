// Generated from packages/rs/model. Do not edit.

export const ModelClass = {
  ChatThinking: "chat-thinking",
  ChatBalanced: "chat-balanced",
  ChatFast: "chat-fast",
  Embedding: "embedding",
} as const;
export type ModelClass = "chat-thinking" | "chat-balanced" | "chat-fast" | "embedding";

export const ReasoningEffort = {
  None: "none",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const;
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelProfile = { 
/**
 * Relative model quality score.
 */
quality?: number, 
/**
 * Relative model speed score.
 */
speed?: number, 
/**
 * Relative model cost score.
 */
cost?: number, };

export type ModelStatus = { 
/**
 * Whether Databricks lists the model as retired or deprecated.
 *
 * @default false
 */
deprecated: boolean, };

export type ServingEndpointSummary = { 
/**
 * Model Serving endpoint name used for invocation.
 */
name: string, 
/**
 * Human-readable endpoint or model name.
 */
displayName?: string, 
/**
 * Normalized model family parsed from the endpoint identities.
 */
family?: string, 
/**
 * Endpoint task, such as chat or embeddings.
 */
task?: string, 
/**
 * Endpoint readiness state.
 */
state?: string, 
/**
 * Endpoint description supplied by Databricks.
 */
description?: string, 
/**
 * Whether the endpoint supports tool calling.
 */
supportsTools?: boolean, 
/**
 * AI Gateway model profile scores.
 */
profile?: ModelProfile, 
/**
 * Intent-oriented endpoint class.
 */
class?: ModelClass, 
/**
 * Provider names mapped to provider-specific model names.
 */
serviceNames?: Record<string, string>, 
/**
 * Foundation model name reported by the served entity.
 */
modelServiceName?: string, 
/**
 * Reasoning effort values accepted by the endpoint.
 */
reasoningEfforts?: Array<ReasoningEffort>, 
/**
 * Retirement status for the served model.
 */
status?: ModelStatus, 
/**
 * Embedding vector dimension measured by the caller, when available.
 */
dimension?: number, };

export type ModelQuery = { 
/**
 * Optional fuzzy model-name search.
 */
search?: string, 
/**
 * Requested model-class ceiling, or the exact embedding class.
 */
modelClass?: ModelClass, 
/**
 * Whether candidates must support tool calling.
 */
requiresTools?: boolean, 
/**
 * Whether retired models remain eligible.
 */
includeDeprecated?: boolean, 
/**
 * Maximum number of results.
 *
 * @schema number().int().min(1).max(50).optional()
 */
limit?: number, 
/**
 * Maximum fuzzy-match distance.
 *
 * @minimum 0
 * @maximum 1
 */
threshold?: number, };

export type RankedModel = { 
/**
 * Matching endpoint metadata.
 */
endpoint: ServingEndpointSummary, 
/**
 * Intent-oriented endpoint class.
 */
modelClass: ModelClass, 
/**
 * Fuzzy-match distance, where lower values are closer.
 */
score?: number, };
