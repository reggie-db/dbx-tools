import { CloudProvider } from "@dbx-tools/shared-core";
import {
  ModelLatencyMeasurementsSchema,
  type ModelLatencyScore,
  type ModelRanking,
  type ModelRating,
  ModelRankingSchema,
  type ModelTokenPrice,
  type ModelTokenPriceCondition,
  type ModelTokenPriceTier,
  type ModelTokenUsdPerDbu,
} from "@dbx-tools/shared-model";
import { load, type CheerioAPI } from "cheerio";
import { z } from "zod";

import { LM_ARENA_DATASET_URL, LM_ARENA_SPLIT, type LMArenaCatalogData } from "./lm-arena.ts";
import type {
  ModelLatencyScoreSnapshot,
  ModelParamsSnapshot,
  ModelCapabilitiesSnapshot,
  ModelRateLimitCatalogue,
  ModelRateLimitsSnapshot,
  ModelTokenPricesSnapshot,
  ModelsDevSnapshot,
  ModelRatingsSnapshot,
  ReasoningModelsSnapshot,
  RetiredModelsSnapshot,
} from "./metadata-contract.ts";
import { inheritsNativeWebSearch, modelSearchQuery } from "./policy.ts";
import {
  parseReasoning,
  REASONING_LEVELS,
  type ReasoningLevel,
  uniqueReasoningLevels,
} from "./reasoning-translation.ts";

type Selection = ReturnType<CheerioAPI>;

const ACCEPTED_VALUES_PATTERN =
  /(?:accepted values(?:\s+are|\s+vary)?|accepts(?:\s+values?(?:\s+of)?)?)\s*:?\s*([^.]+)/gi;
const FOR_MODEL_PATTERN =
  /For\s+([^,]+?),\s+(?:this parameter accepts(?:\s+values?\s+of)?|the (?:`?reasoning_effort`?|effort) parameter accepts(?:\s+values?\s+of)?)\s*([^.]+)/gi;
const TOKEN_PATTERN = /'([^']+)'|"([^"]+)"|`([^`]+)`|\b([a-z][a-z0-9_-]*)\b/gi;
const MODEL_CODE_PATTERN = /\bdatabricks-[a-z0-9][a-z0-9._-]*/gi;
/** Wire tokens advertised in Databricks docs; excludes prose words like `default`. */
const DOCUMENTATION_EFFORT_TOKENS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "extrahigh",
  "ultra",
  "ultra-high",
  "max",
  "maximum",
  "disabled",
]);
const EFFORT_PARAMETER_PATHS = new Set([
  "generationConfig.thinkingConfig.thinkingLevel",
  "output_config.effort",
  "reasoning.effort",
  "reasoning_effort",
]);
const EXTERNAL_ALIAS_SUFFIX_PATTERN = /-(?:customtools|latest|preview|subscription)$/i;
const EXTERNAL_DATE_TOKEN_PATTERN = /-(?:19|20)\d{6}(?=-|$)/g;
const PRICING_FOOTNOTE_PATTERN = /(?:\*+|⌖)+/g;
const PRICING_VERSION_PATTERN = /\bV?\d+(?:\.\d+)*\b/i;
const PRICING_CONDITIONS = new Map<string, ModelTokenPriceCondition>([
  ["", "default"],
  ["short context", "short-context"],
  ["long context", "long-context"],
  ["text tokens", "text-tokens"],
  ["image tokens", "image-tokens"],
  ["audio tokens", "audio-tokens"],
]);

const GENAI_CALCULATOR_COMPONENT =
  "component---src-pages-product-pricing-genai-pricing-calculator-tsx";

const GatsbyChunkMappingSchema = z
  .record(z.string(), z.array(z.string()))
  .describe("Gatsby component chunk paths keyed by component identifier.");

const DatabricksPricingRegionSchema = z
  .object({
    key: z.string().describe("Databricks pricing calculator region key."),
    cloud: z.nativeEnum(CloudProvider).describe("Cloud provider for this price."),
    rate: z.number().nonnegative().describe("Databricks list price in USD per DBU."),
  })
  .passthrough()
  .describe("One Databricks pricing calculator cloud-region rate.");

const ModelsDevModelSchema = z
  .object({
    id: z.string().describe("Provider-specific model identifier."),
    canonical_model_id: z
      .string()
      .optional()
      .describe("Provider-independent canonical model identifier."),
    reasoning: z.boolean().optional().describe("Whether the model supports reasoning."),
    tool_call: z.boolean().optional().describe("Whether the model supports tool calls."),
    structured_output: z
      .boolean()
      .optional()
      .describe("Whether the model supports structured output."),
    temperature: z.boolean().optional().describe("Whether the model accepts temperature."),
    modalities: z
      .object({
        input: z.array(z.string()).describe("Accepted input modalities."),
      })
      .passthrough()
      .optional()
      .describe("Model input and output modalities."),
  })
  .passthrough()
  .describe("One provider model from models.dev.");

const ModelsDevApiSchema = z
  .record(
    z.string(),
    z
      .object({
        models: z
          .record(z.string(), ModelsDevModelSchema)
          .describe("Models available through this provider."),
      })
      .passthrough()
      .describe("One models.dev provider catalogue."),
  )
  .describe("models.dev provider catalogue response.");

const ModelParamsParameterSchema = z
  .object({
    path: z.string().describe("Request-body path for the parameter."),
    group: z.string().optional().describe("Functional parameter group."),
    type: z.string().describe("Parameter value type."),
    values: z
      .array(z.string().nullable())
      .optional()
      .describe("Allowed enum values, including null when omission is supported."),
  })
  .passthrough()
  .describe("One modelparams.dev request parameter.");

const ModelParamsModelSchema = z
  .object({
    provider: z.string().describe("Provider identifier."),
    apiSurface: z.string().describe("Provider API surface."),
    model: z.string().describe("Provider model identifier."),
    params: z.array(ModelParamsParameterSchema).describe("Accepted request parameters."),
  })
  .passthrough()
  .describe("One model and API surface from modelparams.dev.");

const ModelParamsApiSchema = z
  .object({
    models: z.array(ModelParamsModelSchema).describe("Normalized model parameter records."),
  })
  .passthrough()
  .describe("modelparams.dev model catalogue response.");

const ModelLatencyBenchmarkResultSchema = z
  .object({
    model: z.string().describe("Provider model identifier."),
    ok: z.boolean().describe("Whether the benchmark completed successfully."),
    tokens_per_second: z.number().nonnegative().describe("Measured output tokens per second."),
    ttft_millis: z.number().nonnegative().describe("Measured time to first token in milliseconds."),
    successful_runs: z.number().int().nonnegative().describe("Successful measured runs."),
  })
  .passthrough()
  .describe("One model result in the latency benchmark.");

const ModelLatencyBenchmarkSchema = z
  .object({
    generated_at: ModelLatencyMeasurementsSchema.shape.measuredAt.describe(
      "Benchmark publication timestamp normalized to UTC.",
    ),
    max_tokens: z.number().int().positive().describe("Requested completion length."),
    results: z.array(ModelLatencyBenchmarkResultSchema).describe("Measured model results."),
  })
  .passthrough()
  .describe("Public model latency and throughput benchmark snapshot.");

const ArenaPreferenceRankingRowSchema = z
  .object({
    model_name: z.string().describe("Arena model display name."),
    rating: z.number().finite().describe("Arena preference rating."),
    rating_lower: z.number().finite().describe("Arena lower rating confidence bound."),
    rating_upper: z.number().finite().describe("Arena upper rating confidence bound."),
    variance: z.number().finite().nonnegative().describe("Arena rating variance."),
    vote_count: z.coerce.number().int().nonnegative().describe("Arena preference vote count."),
    rank: z.coerce.number().int().positive().describe("Arena category rank."),
    category: z.string().describe("Arena leaderboard category."),
    leaderboard_publish_date: ModelRankingSchema.shape.publishedAt.describe(
      "Arena leaderboard publication date or timestamp normalized to UTC.",
    ),
  })
  .passthrough()
  .describe("One preference-based LMArena ranking row.");

const ArenaAgentRankingRowSchema = z
  .object({
    model_name: z.string().describe("Arena model display name."),
    score: z.number().finite().describe("Arena agent score."),
    score_ci_lower: z.number().finite().describe("Arena agent score lower confidence bound."),
    score_ci_upper: z.number().finite().describe("Arena agent score upper confidence bound."),
    observation_count: z.coerce.number().int().nonnegative().describe("Agent observation count."),
    session_count: z.coerce.number().int().nonnegative().describe("Agent session count."),
    rank: z.coerce.number().int().positive().describe("Arena category rank."),
    category: z.string().describe("Arena leaderboard category."),
    leaderboard_publish_date: ModelRankingSchema.shape.publishedAt.describe(
      "Arena leaderboard publication date or timestamp normalized to UTC.",
    ),
  })
  .passthrough()
  .describe("One agent-based LMArena ranking row.");

/** Parse retired model names from Databricks retirement-policy HTML. */
export function parseRetiredModels(html: string, generatedAt: number): RetiredModelsSnapshot {
  const $ = load(html);
  const models = new Set<string>();
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const header = collapseText($(rows.get(0)).find("th, td").first()).toLowerCase();
    if (header !== "open model" && header !== "partner model") return;
    rows.slice(1).each((__, row) => {
      for (const name of collapseText($(row).find("th, td").first()).split("/")) {
        const trimmed = name.trim();
        if (trimmed) models.add(trimmed);
      }
    });
  });
  if (models.size === 0) throw new Error("Databricks retirement tables contained no model names");
  return {
    generatedAt,
    models: [...models].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    ),
  };
}

/** Parse Responses and web-search documentation into model capability sets. */
export function parseModelCapabilities(
  responsesHtml: string,
  webSearchHtml: string,
  generatedAt: number,
): ModelCapabilitiesSnapshot {
  const responsesDocument = load(responsesHtml);
  const responses = modelsAfterHeading(responsesDocument, "databricks-hosted-foundation-models");
  if (responses.length === 0) {
    throw new Error("Databricks documentation contained no OpenAI Responses models");
  }
  const inputTypes = sectionElements(responsesDocument, "supported-input-types")
    .map((element) => collapseText(element))
    .join(" ")
    .toLowerCase();
  const inputTypeWords = new Set(inputTypes.split(/[^a-z0-9]+/).filter(Boolean));
  const imageInput = inputTypeWords.has("text") && inputTypeWords.has("image") ? responses : [];
  const applyPatch = codeValuesAfterHeading(responsesDocument, "limitations").includes(
    "apply_patch",
  )
    ? responses
    : [];
  const webSearch = nativeWebSearchModels(load(webSearchHtml), responses);
  if (webSearch.length === 0) {
    throw new Error("Databricks documentation contained no native web-search models");
  }
  return {
    generatedAt,
    capabilities: { responses, imageInput, applyPatch, webSearch },
  };
}

/** Normalize portable model capabilities and effort ladders from models.dev JSON. */
export function parseModelsDev(input: unknown, generatedAt: number): ModelsDevSnapshot {
  const providers = ModelsDevApiSchema.parse(input);
  const imageInput = new Set<string>();
  const reasoning = new Set<string>();
  const tools = new Set<string>();
  const structuredOutput = new Set<string>();
  const temperatureSupported = new Set<string>();
  const temperatureUnsupported = new Set<string>();

  for (const [providerId, provider] of Object.entries(providers)) {
    for (const [catalogueId, model] of Object.entries(provider.models)) {
      const keys = externalModelKeys(catalogueId, model.id, model.canonical_model_id);
      if (keys.length === 0) continue;
      for (const key of keys) {
        if (model.modalities?.input.includes("image")) imageInput.add(key);
        if (model.reasoning === true) reasoning.add(key);
        if (model.tool_call === true) tools.add(key);
        if (model.structured_output === true) structuredOutput.add(key);
        if (providerId === "databricks") {
          if (model.temperature === true) temperatureSupported.add(key);
          if (model.temperature === false) temperatureUnsupported.add(key);
        }
      }
    }
  }
  if (reasoning.size === 0 && imageInput.size === 0 && tools.size === 0) {
    throw new Error("models.dev contained no recognized model capabilities");
  }
  return {
    generatedAt,
    capabilities: {
      imageInput: [...imageInput].sort(),
      reasoning: [...reasoning].sort(),
      tools: [...tools].sort(),
      structuredOutput: [...structuredOutput].sort(),
      temperatureSupported: [...temperatureSupported].sort(),
      temperatureUnsupported: [...temperatureUnsupported].sort(),
    },
  };
}

/** Normalize reasoning support and effort ladders from modelparams.dev JSON. */
export function parseModelParams(input: unknown, generatedAt: number): ModelParamsSnapshot {
  const response = ModelParamsApiSchema.parse(input);
  const reasoning = new Set<string>();
  const models: Record<string, ReasoningLevel[]> = {};

  for (const model of response.models) {
    const reasoningParameters = model.params.filter((parameter) => parameter.group === "reasoning");
    if (reasoningParameters.length === 0) continue;
    const keys = externalModelKeys(model.model);
    const levels = sortReasoningLevels(
      reasoningParameters
        .filter(
          (parameter) => parameter.type === "enum" && EFFORT_PARAMETER_PATHS.has(parameter.path),
        )
        .flatMap((parameter) => parameter.values ?? [])
        .flatMap((value) => parseReasoning(value) ?? []),
    );
    if (levels.length === 0) continue;
    for (const key of keys) {
      reasoning.add(key);
      models[key] = sortReasoningLevels([...(models[key] ?? []), ...levels]);
    }
  }
  if (reasoning.size === 0) {
    throw new Error("modelparams.dev contained no recognized reasoning models");
  }
  return {
    generatedAt,
    catalogue: {
      reasoning: [...reasoning].sort(),
      models: sortRecord(models),
    },
  };
}

/** Normalize benchmark throughput and TTFT into a lower-is-faster response-time score. */
export function parseModelLatencyBenchmark(
  input: unknown,
  generatedAt: number,
): ModelLatencyScoreSnapshot {
  const benchmark = ModelLatencyBenchmarkSchema.parse(input);
  const groups = new Map<
    string,
    {
      aliases: Set<string>;
      responseTimes: number[];
      timeToFirstTokens: number[];
      outputTokensPerSecond: number[];
      successfulRunCount: number;
    }
  >();

  for (const result of benchmark.results) {
    if (!result.ok || result.successful_runs === 0 || result.tokens_per_second <= 0) continue;
    const aliases = externalModelKeys(result.model.split("/").at(-1));
    const key = [...aliases].sort((left, right) => left.length - right.length)[0];
    if (!key) continue;
    const group = groups.get(key) ?? {
      aliases: new Set<string>(),
      responseTimes: [],
      timeToFirstTokens: [],
      outputTokensPerSecond: [],
      successfulRunCount: 0,
    };
    for (const alias of aliases) group.aliases.add(alias);
    group.responseTimes.push(
      result.ttft_millis + (benchmark.max_tokens / result.tokens_per_second) * 1000,
    );
    group.timeToFirstTokens.push(result.ttft_millis);
    group.outputTokensPerSecond.push(result.tokens_per_second);
    group.successfulRunCount += result.successful_runs;
    groups.set(key, group);
  }

  if (groups.size === 0) {
    throw new Error("Model latency benchmark contained no successful models");
  }

  const models: Record<string, ModelLatencyScore> = {};
  for (const group of groups.values()) {
    const latencyScore: ModelLatencyScore = {
      score: Math.round(median(group.responseTimes)!),
      measurements: {
        timeToFirstTokenMs: decimalPlaces(median(group.timeToFirstTokens)!, 3),
        outputTokensPerSecond: decimalPlaces(median(group.outputTokensPerSecond)!, 3),
        successfulRunCount: group.successfulRunCount,
        completionTokenCount: benchmark.max_tokens,
        measuredAt: benchmark.generated_at,
      },
    };
    for (const alias of group.aliases) models[alias] = latencyScore;
  }

  return {
    generatedAt,
    source: {
      name: "vicaroai/tokens-per-second",
      url: "https://github.com/vicaroai/tokens-per-second",
      license: "MIT",
      measuredAt: benchmark.generated_at,
      maxTokens: benchmark.max_tokens,
    },
    catalogue: { models: sortRecord(models) },
  };
}

/** Parse the best published overall ranking per configuration and normalized model. */
export function parseArenaModelRatings(
  input: LMArenaCatalogData,
  generatedAt: number,
): ModelRatingsSnapshot {
  const rankingsByModel: Record<string, Record<string, ModelRanking>> = {};
  const maximumRanks = new Map<string, number>();
  const configurations = new Set<string>();
  for (const [configuration, data] of Object.entries(input.configurations)) {
    for (const value of data.rows) {
      const rating = arenaRanking(value);
      if (!rating || rating.category !== "overall") continue;
      maximumRanks.set(
        configuration,
        Math.max(maximumRanks.get(configuration) ?? 0, rating.ranking.rank),
      );
      const modelName = rating.modelName
        .replace(/(?:\s*\([^)]*\)|[-_](?:minimal|low|medium|high|xhigh|max))\s*$/iu, "")
        .trim();
      configurations.add(configuration);
      for (const alias of externalModelKeys(modelName)) {
        const current = rankingsByModel[alias] ?? {};
        const existing = current[configuration];
        if (!existing || rating.ranking.score > existing.score) {
          rankingsByModel[alias] = { ...current, [configuration]: rating.ranking };
        }
      }
    }
  }
  if (Object.keys(rankingsByModel).length === 0) {
    throw new Error("LMArena leaderboard contained no recognized overall model rankings");
  }
  const models = Object.fromEntries(
    Object.entries(rankingsByModel).map(([model, rankings]) => {
      const percentileScores = Object.entries(rankings).map(([configuration, ranking]) =>
        rankPercentile(ranking.rank, maximumRanks.get(configuration) ?? ranking.rank),
      );
      const rating: ModelRating = {
        score: decimalPlaces(
          percentileScores.reduce((total, score) => total + score, 0) / percentileScores.length,
          3,
        ),
        rankings: sortRecord(rankings),
      };
      return [model, rating];
    }),
  );
  return {
    generatedAt,
    source: {
      name: "LMArena leaderboard dataset",
      url: LM_ARENA_DATASET_URL,
      license: "CC-BY-4.0",
      split: LM_ARENA_SPLIT,
      configurations: [...configurations].sort(),
      category: "overall",
    },
    catalogue: { models: sortRecord(models) },
  };
}

function arenaRanking(
  input: unknown,
):
  | { readonly modelName: string; readonly category: string; readonly ranking: ModelRanking }
  | undefined {
  const preference = ArenaPreferenceRankingRowSchema.safeParse(input);
  if (preference.success) {
    const row = preference.data;
    return {
      modelName: row.model_name,
      category: row.category,
      ranking: {
        score: row.rating,
        lowerBound: row.rating_lower,
        upperBound: row.rating_upper,
        variance: row.variance,
        voteCount: row.vote_count,
        rank: row.rank,
        publishedAt: row.leaderboard_publish_date,
      },
    };
  }
  const agent = ArenaAgentRankingRowSchema.safeParse(input);
  if (!agent.success) return undefined;
  const row = agent.data;
  return {
    modelName: row.model_name,
    category: row.category,
    ranking: {
      score: row.score,
      lowerBound: row.score_ci_lower,
      upperBound: row.score_ci_upper,
      observationCount: row.observation_count,
      sessionCount: row.session_count,
      rank: row.rank,
      publishedAt: row.leaderboard_publish_date,
    },
  };
}

/** Parse pay-per-token limits from Databricks Foundation Model API HTML. */
export function parseModelRateLimits(html: string, generatedAt: number): ModelRateLimitsSnapshot {
  const $ = load(html);
  const models: Record<string, ModelRateLimitCatalogue["models"][string]> = {};
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const headers = $(rows.get(0))
      .find("th, td")
      .toArray()
      .map((cell) => collapseText($(cell)).toLowerCase());
    const modelIndex = headers.findIndex((value) => value.includes("model"));
    const inputIndex = headers.findIndex((value) => value.includes("itpm"));
    const outputIndex = headers.findIndex((value) => value.includes("otpm"));
    const queryIndex = headers.findIndex((value) => value.includes("qph"));
    if (modelIndex < 0 || inputIndex < 0 || outputIndex < 0) return;
    rows.slice(1).each((__, row) => {
      const cells = $(row)
        .find("th, td")
        .toArray()
        .map((cell) => collapseText($(cell)));
      const key = modelKey(cells[modelIndex]);
      if (!key) return;
      models[key] = {
        inputTokensPerMinute: number(cells[inputIndex]),
        outputTokensPerMinute: number(cells[outputIndex]),
        queriesPerHour: queryIndex < 0 ? null : number(cells[queryIndex]),
      };
    });
  });
  if (Object.keys(models).length === 0) {
    throw new Error("Databricks model-limit documentation contained no models");
  }
  return { generatedAt, catalogue: { models: sortRecord(models) } };
}

/** Parse Databricks Foundation Model Serving DBU rates per million tokens. */
export function parseModelTokenPrices(
  foundationHtml: string,
  proprietaryHtml: string,
  generatedAt: number,
  calculatorJavascript?: string,
): ModelTokenPricesSnapshot {
  const models: Record<string, ModelTokenPrice[]> = {};
  parseModelTokenPriceDocument(foundationHtml, models);
  parseModelTokenPriceDocument(proprietaryHtml, models);
  const usdPerDbu = calculatorJavascript
    ? parseDatabricksUsdPerDbu(calculatorJavascript)
    : undefined;
  if (Object.keys(models).length === 0) {
    throw new Error("Databricks pricing documentation contained no token prices");
  }
  return {
    generatedAt,
    catalogue: {
      models: sortRecord(
        Object.fromEntries(
          Object.entries(models).map(([key, prices]) => [
            key,
            sortModelTokenPrices(
              prices.map((price) => (usdPerDbu ? { ...price, usdPerDbu } : price)),
            ),
          ]),
        ),
      ),
    },
  };
}

/** Resolve the current Databricks GenAI calculator component asset from Gatsby HTML. */
export function databricksGenAiCalculatorAssetUrl(html: string, pageUrl: string): string {
  const script = load(html)("#gatsby-chunk-mapping").text();
  const assignment = script.match(/window\.___chunkMapping=("(?:\\.|[^"\\])*")/);
  if (!assignment?.[1]) throw new Error("Databricks pricing calculator chunk mapping was missing");
  const serialized = JSON.parse(assignment[1]) as unknown;
  if (typeof serialized !== "string") {
    throw new Error("Databricks pricing calculator chunk mapping was invalid");
  }
  const mapping = GatsbyChunkMappingSchema.parse(JSON.parse(serialized));
  const path = mapping[GENAI_CALCULATOR_COMPONENT]?.[0];
  if (!path) throw new Error("Databricks GenAI calculator component asset was missing");
  return new URL(`/en-pricing-assets${path}`, pageUrl).toString();
}

/** Parse default-cloud USD-per-DBU rates from Databricks' GenAI calculator asset. */
export function parseDatabricksUsdPerDbu(
  calculatorJavascript: string,
): ModelTokenUsdPerDbu | undefined {
  const defaultRegions = calculatorJavascript.match(
    /\{aws:"([^"]+)",gcp:"([^"]+)",azure:"([^"]+)"\}/,
  );
  if (!defaultRegions) return undefined;
  const keys = {
    [CloudProvider.Aws]: defaultRegions[1]!,
    [CloudProvider.Gcp]: defaultRegions[2]!,
    [CloudProvider.Azure]: defaultRegions[3]!,
  } as const;
  for (const match of calculatorJavascript.matchAll(/JSON\.parse\('(\[.*?\])'\)/gs)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    const regions = z.array(DatabricksPricingRegionSchema).safeParse(parsed);
    if (!regions.success) continue;
    const byKey = new Map(regions.data.map((region) => [region.key, region]));
    const selected = Object.entries(keys).map(([provider, key]) => ({
      provider: provider as CloudProvider,
      region: byKey.get(key),
    }));
    if (selected.some(({ provider, region }) => !region || region.cloud !== provider)) continue;
    return {
      [CloudProvider.Aws]: byKey.get(keys[CloudProvider.Aws])!.rate,
      [CloudProvider.Azure]: byKey.get(keys[CloudProvider.Azure])!.rate,
      [CloudProvider.Gcp]: byKey.get(keys[CloudProvider.Gcp])!.rate,
    };
  }
  return undefined;
}

/** Parse reasoning-effort ladders from the Query reasoning models HTML table. */
export function parseReasoningModels(html: string, generatedAt: number): ReasoningModelsSnapshot {
  const $ = load(html);
  const models: Record<string, ReasoningLevel[]> = {};
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const headers = $(rows.get(0))
      .find("th, td")
      .toArray()
      .map((cell) => collapseText($(cell)).toLowerCase());
    if (!headers.some((header) => header.includes("model"))) return;
    if (!headers.some((header) => header.includes("parameter"))) return;
    rows.slice(1).each((__, row) => {
      const cells = $(row)
        .find("th, td")
        .toArray()
        .map((cell) => $(cell));
      if (cells.length < 2) return;
      const modelNames = reasoningModelNamesFromCell(cells[0]!, $);
      if (modelNames.length === 0) return;
      const parametersText = collapseText(cells[cells.length - 1]!);
      const perModel = reasoningLevelsByModelSection(parametersText, modelNames);
      if (Object.keys(perModel).length > 0) {
        for (const [key, levels] of Object.entries(perModel)) {
          if (levels.length > 0) models[key] = sortReasoningLevels(levels);
        }
        return;
      }
      const shared = sortReasoningLevels(extractAcceptedReasoningLevels(parametersText));
      if (shared.length === 0) return;
      for (const name of modelNames) {
        const key = modelKey(name);
        if (key) models[key] = shared;
      }
    });
  });
  if (Object.keys(models).length === 0) {
    throw new Error("Databricks reasoning documentation contained no model effort ladders");
  }
  return { generatedAt, catalogue: { models: sortRecord(models) } };
}

function reasoningModelNamesFromCell(cell: Selection, $: CheerioAPI): string[] {
  const names = new Set<string>();
  cell.find("code").each((_, code) => {
    const text = collapseText($(code));
    if (text.startsWith("databricks-")) names.add(text);
  });
  if (names.size === 0) {
    for (const match of collapseText(cell).matchAll(MODEL_CODE_PATTERN)) {
      names.add(match[0]!);
    }
  }
  return [...names];
}

function parseModelTokenPriceDocument(
  html: string,
  models: Record<string, ModelTokenPrice[]>,
): void {
  const $ = load(html);
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const title = collapseText($(rows.get(0))).toLowerCase();
    if (!title.includes("pay per token") || !title.includes("dbu per 1m tokens")) return;
    const tier: ModelTokenPriceTier = title.includes("priority") ? "priority" : "standard";
    const rateHeaders = $(rows.get(1))
      .find("th, td")
      .toArray()
      .map((cell) => collapseText($(cell)).toLowerCase());
    if (!rateHeaders.includes("input")) return;
    let currentModelKeys: string[] = [];
    rows.slice(2).each((__, row) => {
      const cells = $(row)
        .find("th, td")
        .toArray()
        .map((cell) => collapseText($(cell)));
      if (cells.length <= rateHeaders.length) return;
      const descriptors = cells.slice(0, cells.length - rateHeaders.length);
      const continuedCondition = pricingCondition(descriptors[0]);
      let condition: ModelTokenPriceCondition;
      if (continuedCondition && descriptors.length === 1) {
        condition = continuedCondition;
      } else {
        currentModelKeys = pricingModelKeys(descriptors[0]);
        condition = pricingCondition(descriptors[1]) ?? "default";
      }
      if (currentModelKeys.length === 0) return;
      const values = cells.slice(-rateHeaders.length);
      const price: ModelTokenPrice = {
        tier,
        condition,
        inputDbuPerMillionTokens: pricingRate(rateHeaders, values, "input"),
        outputDbuPerMillionTokens: pricingRate(rateHeaders, values, "output"),
        cacheReadDbuPerMillionTokens: pricingRate(rateHeaders, values, "cache read"),
        cacheWriteDbuPerMillionTokens: pricingRate(rateHeaders, values, "cache write"),
        cacheWriteOneHourDbuPerMillionTokens: pricingRate(rateHeaders, values, "cache write (1hr)"),
      };
      for (const key of currentModelKeys) {
        const prices = models[key] ?? [];
        models[key] = [...prices.filter((existing) => !samePriceRow(existing, price)), price];
      }
    });
  });
}

function pricingCondition(value: string | undefined): ModelTokenPriceCondition | undefined {
  if (value === undefined) return undefined;
  return PRICING_CONDITIONS.get(value.trim().toLowerCase());
}

function pricingRate(
  headers: readonly string[],
  values: readonly string[],
  header: string,
): number | null {
  const index = headers.indexOf(header);
  return index < 0 ? null : decimal(values[index]);
}

function pricingModelKeys(value: string | undefined): string[] {
  if (!value) return [];
  const clean = value.replace(PRICING_FOOTNOTE_PATTERN, "").trim();
  const parts = clean.split(",").map((part) => part.trim());
  const firstVersion = PRICING_VERSION_PATTERN.exec(parts[0] ?? "");
  const prefix = firstVersion ? parts[0]!.slice(0, firstVersion.index) : "";
  const names = parts.map((part, index) => {
    if (index === 0 || !prefix || !PRICING_VERSION_PATTERN.test(part)) return part;
    const version = PRICING_VERSION_PATTERN.exec(part);
    return version?.index === 0 ? `${prefix}${part}` : part;
  });
  return [
    ...new Set(
      names.flatMap((name) => {
        const recognized = modelKey(name);
        if (recognized) return [recognized];
        const literal = literalModelKey(name);
        return literal ? [literal] : [];
      }),
    ),
  ].sort();
}

function literalModelKey(value: string): string | undefined {
  const normalized = value
    .toLowerCase()
    .replace(/^system\.ai[.-]/, "")
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function samePriceRow(left: ModelTokenPrice, right: ModelTokenPrice): boolean {
  return left.tier === right.tier && left.condition === right.condition;
}

function sortModelTokenPrices(prices: readonly ModelTokenPrice[]): ModelTokenPrice[] {
  const tiers: readonly ModelTokenPriceTier[] = ["standard", "priority"];
  const conditions: readonly ModelTokenPriceCondition[] = [
    "default",
    "short-context",
    "long-context",
    "text-tokens",
    "image-tokens",
    "audio-tokens",
  ];
  return [...prices].sort((left, right) => {
    const tier = tiers.indexOf(left.tier) - tiers.indexOf(right.tier);
    return tier || conditions.indexOf(left.condition) - conditions.indexOf(right.condition);
  });
}

function extractAcceptedReasoningLevels(text: string): ReasoningLevel[] {
  const levels: ReasoningLevel[] = [];
  for (const match of text.matchAll(ACCEPTED_VALUES_PATTERN)) {
    const fragment = match[1];
    if (!fragment || /vary by model/i.test(fragment)) continue;
    levels.push(...documentationEffortLevels(fragment));
  }
  return levels;
}

function reasoningLevelsByModelSection(
  parametersText: string,
  rowModels: readonly string[],
): Record<string, ReasoningLevel[]> {
  const result: Record<string, ReasoningLevel[]> = {};
  for (const match of parametersText.matchAll(FOR_MODEL_PATTERN)) {
    const label = match[1]?.trim();
    const fragment = match[2];
    if (!label || !fragment) continue;
    const levels = uniqueReasoningLevels(documentationEffortLevels(fragment));
    if (levels.length === 0) continue;
    const matched = rowModels.filter((model) => reasoningModelLabelMatches(label, model));
    // Only attach explicit "For <model>" clauses to models listed in the row.
    if (matched.length === 0) continue;
    for (const target of matched) {
      const key = modelKey(target);
      if (key) result[key] = sortReasoningLevels(levels);
    }
  }
  return result;
}

function documentationEffortLevels(fragment: string): ReasoningLevel[] {
  return reasoningTokensFromFragment(fragment).flatMap((token) => {
    const normalized = token.toLowerCase().replace(/[_\s]+/g, "-");
    if (
      !DOCUMENTATION_EFFORT_TOKENS.has(normalized) &&
      !DOCUMENTATION_EFFORT_TOKENS.has(token.toLowerCase())
    ) {
      return [];
    }
    const level = parseReasoning(token);
    return level ? [level] : [];
  });
}

function sortReasoningLevels(levels: readonly ReasoningLevel[]): ReasoningLevel[] {
  return uniqueReasoningLevels(levels).sort(
    (left, right) => REASONING_LEVELS.indexOf(left) - REASONING_LEVELS.indexOf(right),
  );
}

function reasoningModelLabelMatches(label: string, model: string): boolean {
  const left = label
    .toLowerCase()
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "");
  const right = model
    .toLowerCase()
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "");
  return left === right || right.includes(left) || left.includes(right);
}

function reasoningTokensFromFragment(fragment: string): string[] {
  const tokens: string[] = [];
  for (const part of fragment.matchAll(TOKEN_PATTERN)) {
    const token = part[1] ?? part[2] ?? part[3] ?? part[4];
    if (!token || token === "and" || token === "or" || token === "of") continue;
    tokens.push(token.replace(/^["'`]+|["'`]+$/g, ""));
  }
  return tokens;
}

function modelsAfterHeading($: CheerioAPI, headingId: string): string[] {
  return [
    ...new Set(codeValuesAfterHeading($, headingId).flatMap((value) => modelKey(value) ?? [])),
  ].sort();
}

function nativeWebSearchModels($: CheerioAPI, responses: readonly string[]): string[] {
  const models = new Set<string>();
  let nativeSection = false;
  for (const element of sectionElements($, "supported-models")) {
    if (headingLevel(nodeTagName(element.get(0))) !== undefined) {
      nativeSection = !collapseText(element).toLowerCase().includes("via mcp");
      continue;
    }
    if (!nativeSection) continue;
    const values = nodeTagName(element.get(0)) === "code" ? [collapseText(element)] : [];
    element.find("code").each((_, code) => {
      values.push(collapseText($(code)));
    });
    for (const value of values) {
      const model = modelKey(value);
      if (!model) continue;
      models.add(model);
    }
  }
  for (const model of responses) {
    if (inheritsNativeWebSearch(model, models)) models.add(model);
  }
  return [...models].sort();
}

function codeValuesAfterHeading($: CheerioAPI, headingId: string): string[] {
  const values: string[] = [];
  for (const element of sectionElements($, headingId)) {
    if (nodeTagName(element.get(0)) === "code") values.push(collapseText(element));
    element.find("code").each((_, code) => {
      values.push(collapseText($(code)));
    });
  }
  return values;
}

function sectionElements($: CheerioAPI, headingId: string): Selection[] {
  const heading = $(`#${headingId}`).first();
  if (heading.length === 0) {
    throw new Error(`Databricks capability page is missing section ${headingId}`);
  }
  const level = headingLevel(nodeTagName(heading.get(0)));
  if (level === undefined) {
    throw new Error(`Databricks capability section ${headingId} is not a heading`);
  }
  const elements: Selection[] = [];
  let sibling = heading.next();
  while (sibling.length > 0) {
    const siblingLevel = headingLevel(nodeTagName(sibling.get(0)));
    if (siblingLevel !== undefined && siblingLevel <= level) break;
    elements.push(sibling);
    sibling = sibling.next();
  }
  return elements;
}

function headingLevel(name: string | undefined): number | undefined {
  const match = /^h([1-6])$/.exec(name ?? "");
  return match ? Number(match[1]) : undefined;
}

function collapseText(element: Selection): string {
  return element.text().split(/\s+/).filter(Boolean).join(" ");
}

function nodeTagName(node: unknown): string | undefined {
  if (!node || typeof node !== "object" || !("tagName" in node)) return undefined;
  return typeof node.tagName === "string" ? node.tagName : undefined;
}

function modelKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let name = value.trim().replace(/\*+$/, "").trim();
  for (const suffix of ["(Public Preview)", "(Beta)", "(Preview)"]) {
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
  }
  return modelSearchQuery(name)?.replaceAll(" ", "-");
}

function externalModelKeys(...values: readonly (string | undefined)[]): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const queue = [value, value.replace(EXTERNAL_DATE_TOKEN_PATTERN, "")];
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      if (aliases.has(candidate)) continue;
      aliases.add(candidate);
      const trimmed = candidate.replace(EXTERNAL_ALIAS_SUFFIX_PATTERN, "");
      if (trimmed !== candidate) queue.push(trimmed);
    }
  }
  return [...new Set([...aliases].flatMap((alias) => modelKey(alias) ?? []))].sort();
}

function number(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function decimal(value: string | undefined): number | null {
  if (!value || value.trim() === "-") return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

function decimalPlaces(value: number, places: number): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

function rankPercentile(rank: number, maximumRank: number): number {
  if (maximumRank <= 1) return 100;
  return Math.max(0, Math.min(100, (1 - (rank - 1) / (maximumRank - 1)) * 100));
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
