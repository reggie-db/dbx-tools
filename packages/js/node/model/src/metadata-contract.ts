import {
  ModelLatencyScoreSchema,
  ModelRatingSchema,
  ModelRateLimitsSchema,
  ModelTokenPriceSchema,
} from "@dbx-tools/shared-model";
import { z } from "zod";

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

/** Databricks pricing URL for open foundation-model token rates. */
export const FOUNDATION_MODEL_PRICING_URL =
  "https://www.databricks.com/product/pricing/foundation-model-serving";

/** Databricks pricing URL for proprietary foundation-model token rates. */
export const PROPRIETARY_MODEL_PRICING_URL =
  "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving";

/** Databricks GenAI calculator used to publish cloud-specific USD-per-DBU prices. */
export const GENAI_PRICING_CALCULATOR_URL =
  "https://www.databricks.com/product/pricing/genai-pricing-calculator";

/** Databricks documentation URL for reasoning-effort model policy. */
export const QUERY_REASON_MODELS_URL =
  "https://docs.databricks.com/aws/en/machine-learning/model-serving/query-reason-models";

/** models.dev provider catalogue URL. */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** modelparams.dev normalized model-parameter catalogue URL. */
export const MODELPARAMS_DEV_MODELS_URL = "https://modelparams.dev/api/v1/models.json";

/** Public weekly latency and throughput benchmark snapshot. */
export const MODEL_LATENCY_BENCHMARK_URL =
  "https://raw.githubusercontent.com/vicaroai/tokens-per-second/main/benchmarks/results/latest.json";

const generatedAtSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Unix timestamp when dbx-tools generated this snapshot.");

export const RetiredModelsSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    models: z.array(z.string()).readonly().describe("Retired foundation-model names."),
  })
  .readonly()
  .describe("Build-generated retired-model snapshot.");

export type RetiredModelsSnapshot = z.infer<typeof RetiredModelsSnapshotSchema>;

export const ModelCapabilityCatalogueSchema = z
  .object({
    responses: z.array(z.string()).readonly().describe("Models supporting OpenAI Responses."),
    imageInput: z.array(z.string()).readonly().describe("Models accepting image input."),
    applyPatch: z.array(z.string()).readonly().describe("Models supporting apply_patch."),
    webSearch: z.array(z.string()).readonly().describe("Models supporting native web search."),
  })
  .readonly()
  .describe("Normalized model identities grouped by documented capability.");

export type ModelCapabilityCatalogue = z.infer<typeof ModelCapabilityCatalogueSchema>;

export const ModelCapabilitiesSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    capabilities: ModelCapabilityCatalogueSchema.describe("Documented model capabilities."),
  })
  .readonly()
  .describe("Build-generated model-capability snapshot.");

export type ModelCapabilitiesSnapshot = z.infer<typeof ModelCapabilitiesSnapshotSchema>;

export const ModelRateLimitCatalogueSchema = z
  .object({
    models: z
      .record(z.string(), ModelRateLimitsSchema)
      .readonly()
      .describe("Published rate limits keyed by normalized Databricks model identity."),
  })
  .readonly()
  .describe("Model limits keyed by normalized Databricks model identity.");

export type ModelRateLimitCatalogue = z.infer<typeof ModelRateLimitCatalogueSchema>;

export const ModelRateLimitsSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    catalogue: ModelRateLimitCatalogueSchema.describe("Documented model rate limits."),
  })
  .readonly()
  .describe("Build-generated model-rate-limit snapshot.");

export type ModelRateLimitsSnapshot = z.infer<typeof ModelRateLimitsSnapshotSchema>;

export const ModelTokenPriceCatalogueSchema = z
  .object({
    models: z
      .record(z.string(), z.array(ModelTokenPriceSchema).readonly())
      .readonly()
      .describe("Databricks token-price rows keyed by normalized model identity."),
  })
  .readonly()
  .describe("Databricks token prices keyed by normalized model identity.");

export type ModelTokenPriceCatalogue = z.infer<typeof ModelTokenPriceCatalogueSchema>;

export const ModelTokenPricesSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    catalogue: ModelTokenPriceCatalogueSchema.describe("Documented Databricks token prices."),
  })
  .readonly()
  .describe("Build-generated Databricks token-price snapshot.");

export type ModelTokenPricesSnapshot = z.infer<typeof ModelTokenPricesSnapshotSchema>;

export const DocumentedReasoningCatalogueSchema = z
  .object({
    models: z
      .record(z.string(), z.array(z.string()).readonly())
      .readonly()
      .describe("Documented effort labels keyed by normalized model identity."),
  })
  .readonly()
  .describe("Reasoning effort labels collected from model documentation.");

export type DocumentedReasoningCatalogue = z.infer<typeof DocumentedReasoningCatalogueSchema>;

export const ReasoningModelsSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    catalogue: DocumentedReasoningCatalogueSchema.describe(
      "Documented reasoning-effort catalogue.",
    ),
  })
  .readonly()
  .describe("Build-generated reasoning-effort documentation snapshot.");

export type ReasoningModelsSnapshot = z.infer<typeof ReasoningModelsSnapshotSchema>;

export const ModelsDevCapabilityCatalogueSchema = z
  .object({
    imageInput: z.array(z.string()).readonly().describe("Models accepting image input."),
    reasoning: z.array(z.string()).readonly().describe("Models supporting reasoning."),
    tools: z.array(z.string()).readonly().describe("Models supporting tool calls."),
    structuredOutput: z
      .array(z.string())
      .readonly()
      .describe("Models supporting structured output."),
    temperatureSupported: z
      .array(z.string())
      .readonly()
      .describe("Models accepting temperature configuration."),
    temperatureUnsupported: z
      .array(z.string())
      .readonly()
      .describe("Models rejecting temperature configuration."),
  })
  .readonly()
  .describe("Portable capability sets normalized from models.dev.");

export type ModelsDevCapabilityCatalogue = z.infer<typeof ModelsDevCapabilityCatalogueSchema>;

export const ModelsDevSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    capabilities: ModelsDevCapabilityCatalogueSchema.describe(
      "Normalized models.dev capabilities.",
    ),
  })
  .readonly()
  .describe("Build-generated models.dev capability and reasoning snapshot.");

export type ModelsDevSnapshot = z.infer<typeof ModelsDevSnapshotSchema>;

export const ModelParamsCatalogueSchema = DocumentedReasoningCatalogueSchema.unwrap()
  .extend({
    reasoning: z.array(z.string()).readonly().describe("Model identities supporting reasoning."),
  })
  .readonly()
  .describe("Reasoning support and discrete effort levels normalized from modelparams.dev.");

export type ModelParamsCatalogue = z.infer<typeof ModelParamsCatalogueSchema>;

export const ModelParamsSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    catalogue: ModelParamsCatalogueSchema.describe(
      "Normalized modelparams.dev reasoning catalogue.",
    ),
  })
  .readonly()
  .describe("Build-generated modelparams.dev reasoning snapshot.");

export type ModelParamsSnapshot = z.infer<typeof ModelParamsSnapshotSchema>;

export const ModelLatencyScoreCatalogueSchema = z
  .object({
    models: z
      .record(z.string(), ModelLatencyScoreSchema)
      .describe("Normalized latency metadata keyed by normalized model identity."),
  })
  .describe("Model latency scores and measurements derived from one benchmark snapshot.");

export type ModelLatencyScoreCatalogue = z.infer<typeof ModelLatencyScoreCatalogueSchema>;

export const ModelLatencyScoreSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    source: z
      .object({
        name: z.string().describe("Benchmark dataset name."),
        url: z.url().describe("Benchmark snapshot URL."),
        license: z.string().describe("Benchmark dataset license identifier."),
        measuredAt: z.iso.datetime().describe("Timestamp published by the benchmark dataset."),
        maxTokens: z
          .number()
          .int()
          .positive()
          .describe("Fixed completion length used to normalize response time."),
      })
      .describe("Benchmark source and normalization context."),
    catalogue: ModelLatencyScoreCatalogueSchema,
  })
  .describe("Build-generated model latency score snapshot.");

export type ModelLatencyScoreSnapshot = z.infer<typeof ModelLatencyScoreSnapshotSchema>;

export const ModelRatingCatalogueSchema = z
  .object({
    models: z
      .record(z.string(), ModelRatingSchema)
      .describe("Aggregate Arena quality scores keyed by normalized model identity."),
  })
  .describe("Model ratings derived from one Arena leaderboard snapshot.");

export type ModelRatingCatalogue = z.infer<typeof ModelRatingCatalogueSchema>;

export const ModelRatingsSnapshotSchema = z
  .object({
    generatedAt: generatedAtSchema,
    source: z
      .object({
        name: z.string().describe("Benchmark dataset name."),
        url: z.url().describe("Benchmark dataset page."),
        license: z.string().describe("Benchmark dataset license identifier."),
        split: z.string().describe("Dataset split used for the ratings."),
        configurations: z
          .array(z.string())
          .describe("Dataset configurations retained in the snapshot."),
        category: z.string().describe("Leaderboard category retained in the snapshot."),
      })
      .describe("Arena leaderboard source and selection context."),
    catalogue: ModelRatingCatalogueSchema,
  })
  .describe("Build-generated Arena model ratings snapshot.");

export type ModelRatingsSnapshot = z.infer<typeof ModelRatingsSnapshotSchema>;
