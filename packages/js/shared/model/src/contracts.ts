/** Browser-safe model contracts owned by the TypeScript model runtime. */

export const ModelClass = {
  ChatThinking: "chat-thinking",
  ChatBalanced: "chat-balanced",
  ChatFast: "chat-fast",
  Embedding: "embedding",
} as const;
export type ModelClass = (typeof ModelClass)[keyof typeof ModelClass];

export const ReasoningEffort = {
  None: "none",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const;
export type ReasoningEffort = (typeof ReasoningEffort)[keyof typeof ReasoningEffort];

export interface ModelProfile {
  /** Relative model quality score. */
  readonly quality?: number;
  /** Relative model speed score. */
  readonly speed?: number;
  /** Relative model cost score. */
  readonly cost?: number;
}

export interface ModelStatus {
  /** Whether Databricks lists the model as retired or deprecated. */
  readonly deprecated: boolean;
}

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
  readonly serviceNames?: Readonly<Record<string, string>>;
  /** Foundation model name reported by the served entity. */
  readonly modelServiceName?: string;
  /** Reasoning effort values accepted by the endpoint. */
  readonly reasoningEfforts?: readonly ReasoningEffort[];
  /** Retirement status for the served model. */
  readonly status?: ModelStatus;
  /** Embedding vector dimension measured by the caller, when available. */
  readonly dimension?: number;
}

export interface ModelQuery {
  /** Optional fuzzy model-name search. */
  readonly search?: string;
  /** Requested model-class ceiling, or the exact embedding class. */
  readonly modelClass?: ModelClass;
  /** Whether candidates must support tool calling. */
  readonly requiresTools?: boolean;
  /** Whether retired models remain eligible. */
  readonly includeDeprecated?: boolean;
  /** Maximum number of results. */
  readonly limit?: number;
  /** Maximum fuzzy-match distance. */
  readonly threshold?: number;
}

export interface RankedModel {
  /** Matching endpoint metadata. */
  readonly endpoint: ServingEndpointSummary;
  /** Intent-oriented endpoint class. */
  readonly modelClass: ModelClass;
  /** Fuzzy-match distance, where lower values are closer. */
  readonly score?: number;
}
