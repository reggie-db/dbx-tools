/** Browser-safe model contracts owned by the TypeScript model runtime. */

/** Intent-oriented endpoint class slug. */
export type ModelClass = "chat-thinking" | "chat-balanced" | "chat-fast" | "embedding";

export const ModelClass = {
  ChatThinking: "chat-thinking",
  ChatBalanced: "chat-balanced",
  ChatFast: "chat-fast",
  Embedding: "embedding",
} as const satisfies Record<string, ModelClass>;

/** Reasoning effort value accepted by compatible model endpoints. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const ReasoningEffort = {
  None: "none",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const satisfies Record<string, ReasoningEffort>;

/** Relative quality, speed, and cost scores for an endpoint. */
export interface ModelProfile {
  /** Relative model quality score. */
  readonly quality?: number;
  /** Relative model speed score. */
  readonly speed?: number;
  /** Relative model cost score. */
  readonly cost?: number;
}

/** Model retirement status. */
export interface ModelStatus {
  /**
   * Whether Databricks lists the model as retired or deprecated.
   *
   * @default false
   */
  readonly deprecated: boolean;
}

/** Browser-safe normalized Model Serving endpoint metadata. */
export interface ServingEndpointSummary {
  /** Model Serving endpoint name used for invocation. */
  readonly name: string;
  /** Human-readable endpoint or model name. */
  readonly displayName?: string;
  /** Normalized model family parsed from the endpoint identities. */
  readonly family?: string;
  /** Endpoint task, such as chat or embeddings. */
  readonly task?: string;
  /** Endpoint readiness state. */
  readonly state?: string;
  /** Endpoint description supplied by Databricks. */
  readonly description?: string;
  /** Whether the endpoint supports tool calling. */
  readonly supportsTools?: boolean;
  /** AI Gateway model profile scores. */
  readonly profile?: ModelProfile;
  /** Intent-oriented endpoint class. */
  readonly class?: ModelClass;
  /** Provider names mapped to provider-specific model names. */
  readonly serviceNames?: Record<string, string>;
  /** Foundation model name reported by the served entity. */
  readonly modelServiceName?: string;
  /** Reasoning effort values accepted by the endpoint. */
  readonly reasoningEfforts?: ReasoningEffort[];
  /** Retirement status for the served model. */
  readonly status?: ModelStatus;
  /** Embedding vector dimension measured by the caller, when available. */
  readonly dimension?: number;
}

/** Browser-safe model catalogue search and ranking controls. */
export interface ModelQuery {
  /** Optional fuzzy model-name search. */
  readonly search?: string;
  /** Requested model-class ceiling, or the exact embedding class. */
  readonly modelClass?: ModelClass;
  /** Whether candidates must support tool calling. */
  readonly requiresTools?: boolean;
  /** Whether retired models remain eligible. */
  readonly includeDeprecated?: boolean;
  /**
   * Maximum number of results.
   *
   * @schema number().int().min(1).max(50).optional()
   */
  readonly limit?: number;
  /**
   * Maximum fuzzy-match distance.
   *
   * @minimum 0
   * @maximum 1
   */
  readonly threshold?: number;
}

/** One ranked model-search result. */
export interface RankedModel {
  /** Matching endpoint metadata. */
  readonly endpoint: ServingEndpointSummary;
  /** Intent-oriented endpoint class. */
  readonly modelClass: ModelClass;
  /**
   * Fuzzy-match distance, where lower values are closer.
   *
   * @minimum 0
   * @maximum 1
   */
  readonly score?: number;
}

/** Capabilities derived from one normalized serving endpoint. */
export interface EndpointCapabilities {
  /** Whether the endpoint accepts chat or Responses requests. */
  readonly chat: boolean;
  /** Whether the endpoint produces embedding vectors. */
  readonly embedding: boolean;
  /** Whether the endpoint supports a complete function-tool round trip. */
  readonly tools: boolean;
}

/** Fallback class and rank for an unscored recognized model family. */
export interface FamilyClass {
  /** Chat capability band assigned to the family. */
  readonly class: ModelClass;
  /**
   * Intra-family ordering hint.
   *
   * @minimum 0
   */
  readonly rank: number;
}

/** Documented capabilities resolved for one model identity. */
export interface ModelCapabilities {
  readonly responses: boolean;
  readonly imageInput: boolean;
  readonly applyPatch: boolean;
  readonly webSearch: boolean;
}

/** Published pay-per-token limits for one model. */
export interface ModelRateLimits {
  /** @schema number().int().min(0).nullable() */
  readonly inputTokensPerMinute: number | null;
  /** @schema number().int().min(0).nullable() */
  readonly outputTokensPerMinute: number | null;
  /** @schema number().int().min(0).nullable() */
  readonly queriesPerHour: number | null;
}

/** Combined retirement, capability, and rate-limit metadata. */
export interface ModelMetadata {
  readonly status: ModelStatus;
  readonly capabilities: ModelCapabilities;
  readonly rateLimits?: ModelRateLimits;
}

/** Result of resolving a fuzzy model identifier. */
export interface ResolvedModel {
  readonly modelId: string;
  readonly matched: boolean;
  /**
   * @minimum 0
   * @maximum 1
   */
  readonly score?: number;
}

/** Pure controls for fuzzy endpoint resolution. */
export interface ResolveModelOptions {
  /**
   * Maximum fuzzy-match distance.
   *
   * @minimum 0
   * @maximum 1
   */
  readonly threshold?: number;
  /** Whether candidates must support tool calling. */
  readonly requiresTools?: boolean;
}

/** One endpoint paired with its fuzzy-match distance. */
export interface ScoredEndpoint {
  readonly endpoint: ServingEndpointSummary;
  /**
   * @minimum 0
   * @maximum 1
   */
  readonly score: number;
}

/** Caller intent used to resolve one model from a catalogue. */
export interface ResolveModelInput {
  readonly explicit?: string;
  readonly fuzzy?: boolean;
  /**
   * @minimum 0
   * @maximum 1
   */
  readonly threshold?: number;
  readonly requiresTools?: boolean;
  readonly modelClass?: ModelClass;
  readonly fallbacks?: string[];
  readonly liveOnly?: boolean;
}

/** Selected model identifier and the policy branch that selected it. */
export interface ResolvedModelSelection {
  readonly modelId: string;
  readonly source: "explicit" | "fuzzy-match" | "class" | "fallback";
}
