/** One day, matching the refresh cadence of Databricks model documentation. */
export const MODEL_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/** Databricks documentation URL for retired foundation models. */
export const RETIRED_MODELS_URL =
  "https://docs.databricks.com/aws/en/machine-learning/retired-models-policy";

/** Databricks documentation URL for OpenAI Responses model support. */
export const OPENAI_RESPONSES_MODELS_URL =
  "https://docs.databricks.com/aws/en/machine-learning/model-serving/query-openai-responses";

/** Databricks documentation URL for native web-search model support. */
export const WEB_SEARCH_MODELS_URL =
  "https://docs.databricks.com/aws/en/machine-learning/model-serving/web-search";

/** Databricks documentation URL for Foundation Model API limits. */
export const MODEL_RATE_LIMITS_URL =
  "https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/limits";

/** Build-generated retired-model snapshot. */
export interface RetiredModelsSnapshot {
  readonly generatedAt: number;
  readonly models: readonly string[];
}

/** Normalized model identities grouped by documented capability. */
export interface ModelCapabilityCatalogue {
  readonly responses: readonly string[];
  readonly imageInput: readonly string[];
  readonly applyPatch: readonly string[];
  readonly webSearch: readonly string[];
}

/** Build-generated model-capability snapshot. */
export interface ModelCapabilitiesSnapshot {
  readonly generatedAt: number;
  readonly capabilities: ModelCapabilityCatalogue;
}

/** Published pay-per-token limits for one model. */
export interface ModelRateLimits {
  readonly inputTokensPerMinute: number | null;
  readonly outputTokensPerMinute: number | null;
  readonly queriesPerHour: number | null;
}

/** Model limits keyed by normalized Databricks model identity. */
export interface ModelRateLimitCatalogue {
  readonly models: Readonly<Record<string, ModelRateLimits>>;
}

/** Build-generated model-rate-limit snapshot. */
export interface ModelRateLimitsSnapshot {
  readonly generatedAt: number;
  readonly catalogue: ModelRateLimitCatalogue;
}
