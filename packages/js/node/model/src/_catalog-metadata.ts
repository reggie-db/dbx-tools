/** Adapt the public model catalog to the established @dbx-tools/model metadata API. */
import type { CatalogModelRecord } from "@dbx-tools/dbx-model-catalog";
import type { ModelCatalogIndex } from "@dbx-tools/dbx-model-catalog/snapshot";
import type {
  ModelLatencyScore,
  ModelRating,
  ModelRateLimits,
  ModelRanking,
  ModelTokenPrice,
} from "@dbx-tools/shared-model";

import { modelSearchQuery } from "./policy.ts";

export interface CatalogMetadataInput {
  readonly retiredNames: readonly string[];
  readonly capabilities: Readonly<{
    responses: readonly string[];
    imageInput: readonly string[];
    applyPatch: readonly string[];
    webSearch: readonly string[];
  }>;
  readonly modelsDev: Readonly<{
    imageInput: readonly string[];
    reasoning: readonly string[];
    tools: readonly string[];
    structuredOutput: readonly string[];
    temperatureSupported: readonly string[];
    temperatureUnsupported: readonly string[];
  }>;
  readonly modelParams: Readonly<{
    reasoning: readonly string[];
    models: Readonly<Record<string, readonly string[]>>;
  }>;
  readonly rateLimits: Readonly<Record<string, ModelRateLimits>>;
  readonly tokenPrices: Readonly<Record<string, readonly ModelTokenPrice[]>>;
  readonly latencyScores: Readonly<Record<string, ModelLatencyScore>>;
  readonly ratings: Readonly<Record<string, ModelRating>>;
  readonly reasoning: Readonly<Record<string, readonly string[]>>;
}

export interface CatalogMetadataCompatibility {
  readonly modelsDev?: CatalogMetadataInput["modelsDev"];
}

export function metadataFromCatalog(
  index: ModelCatalogIndex,
  compatibility: CatalogMetadataCompatibility = {},
): CatalogMetadataInput {
  const responses = new Set<string>();
  const imageInput = new Set<string>();
  const applyPatch = new Set<string>();
  const webSearch = new Set<string>();
  const reasoning = new Set<string>();
  const tools = new Set<string>();
  const structuredOutput = new Set<string>();
  const temperatureSupported = new Set<string>();
  const temperatureUnsupported = new Set<string>();
  const reasoningModels: Record<string, readonly string[]> = {};
  const rateLimits: Record<string, ModelRateLimits> = {};
  const tokenPrices: Record<string, readonly ModelTokenPrice[]> = {};
  const latencyScores: Record<string, ModelLatencyScore> = {};
  const ratings = catalogRatings(index.records);
  const retiredNames = new Set<string>();
  const latencyValues = new Map<string, ModelLatencyScore>();

  for (const record of index.records) {
    const keys = catalogKeys(record);
    if (record.status === "deprecated" || record.status === "retired") {
      retiredNames.add(record.name);
    }
    addWhen(responses, keys, record.capabilities.responses);
    addWhen(imageInput, keys, record.modalities.input.includes("image"));
    addWhen(applyPatch, keys, record.capabilities.apply_patch);
    addWhen(webSearch, keys, record.capabilities.web_search);
    addWhen(reasoning, keys, record.capabilities.reasoning?.supported === true);
    addWhen(tools, keys, record.capabilities.tools === true);
    addWhen(structuredOutput, keys, record.capabilities.structured_output === true);
    addWhen(temperatureSupported, keys, record.capabilities.temperature === true);
    addWhen(temperatureUnsupported, keys, record.capabilities.temperature === false);

    const efforts = record.capabilities.reasoning?.supported
      ? (record.capabilities.reasoning.effort ?? [])
      : [];
    const prices = catalogTokenPrices(record);
    for (const key of keys) {
      if (efforts.length) reasoningModels[key] = efforts;
      if (record.rate_limits) {
        rateLimits[key] = {
          inputTokensPerMinute: record.rate_limits.input_tokens_per_minute,
          outputTokensPerMinute: record.rate_limits.output_tokens_per_minute,
          queriesPerHour: record.rate_limits.queries_per_hour,
        };
      }
      if (prices.length) tokenPrices[key] = prices;
      if (record.latency) {
        const value: ModelLatencyScore = {
          score: record.latency.score,
          measurements: {
            timeToFirstTokenMs: record.latency.measurements.time_to_first_token_ms,
            outputTokensPerSecond: record.latency.measurements.output_tokens_per_second,
            successfulRunCount: record.latency.measurements.successful_run_count,
            completionTokenCount: record.latency.measurements.completion_token_count,
            measuredAt: record.latency.measurements.measured_at,
          },
        };
        const identity = JSON.stringify(value);
        latencyScores[key] = latencyValues.get(identity) ?? value;
        latencyValues.set(identity, latencyScores[key]!);
      }
      const rating = ratings.byId.get(record.id);
      if (rating) ratings.byKey[key] = rating;
    }
  }
  mergeCompatibilityCapabilities(index, compatibility.modelsDev, {
    imageInput,
    reasoning,
    tools,
    structuredOutput,
    temperatureSupported,
    temperatureUnsupported,
  });

  return {
    retiredNames: [...retiredNames],
    capabilities: {
      responses: [...responses],
      imageInput: [...imageInput],
      applyPatch: [...applyPatch],
      webSearch: [...webSearch],
    },
    modelsDev: {
      imageInput: [],
      reasoning: [...reasoning],
      tools: [...tools],
      structuredOutput: [...structuredOutput],
      temperatureSupported: [...temperatureSupported],
      temperatureUnsupported: [...temperatureUnsupported],
    },
    modelParams: { reasoning: [], models: {} },
    rateLimits,
    tokenPrices,
    latencyScores,
    ratings: ratings.byKey,
    reasoning: reasoningModels,
  };
}

function mergeCompatibilityCapabilities(
  index: ModelCatalogIndex,
  fallback: CatalogMetadataInput["modelsDev"] | undefined,
  target: {
    readonly imageInput: Set<string>;
    readonly reasoning: Set<string>;
    readonly tools: Set<string>;
    readonly structuredOutput: Set<string>;
    readonly temperatureSupported: Set<string>;
    readonly temperatureUnsupported: Set<string>;
  },
): void {
  if (!fallback) return;
  addMissing(
    fallback.imageInput,
    target.imageInput,
    (record) =>
      record.sources.modalities === undefined && !record.modalities.input.includes("image"),
  );
  addMissing(
    fallback.reasoning,
    target.reasoning,
    (record) => record.capabilities.reasoning === null,
  );
  addMissing(fallback.tools, target.tools, (record) => record.capabilities.tools === null);
  addMissing(
    fallback.structuredOutput,
    target.structuredOutput,
    (record) => record.capabilities.structured_output === null,
  );
  addMissing(
    fallback.temperatureSupported,
    target.temperatureSupported,
    (record) => record.capabilities.temperature === null,
  );
  addMissing(
    fallback.temperatureUnsupported,
    target.temperatureUnsupported,
    (record) => record.capabilities.temperature === null,
  );

  function addMissing(
    values: readonly string[],
    output: Set<string>,
    isMissing: (record: CatalogModelRecord) => boolean,
  ): void {
    for (const value of values) {
      const match = index.resolve(value);
      if (!match || isMissing(match.record)) output.add(value);
    }
  }
}

function catalogKeys(record: CatalogModelRecord): string[] {
  return [record.id, record.name, ...record.aliases]
    .map((value) => modelKey(value))
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function modelKey(value: string): string | undefined {
  return modelSearchQuery(value)?.replaceAll(" ", "-");
}

function addWhen(target: Set<string>, keys: readonly string[], condition: boolean): void {
  if (!condition) return;
  for (const key of keys) target.add(key);
}

function catalogTokenPrices(record: CatalogModelRecord): ModelTokenPrice[] {
  const rates = record.average_price.DBU?.rates;
  if (!rates) return [];
  const rows = new Map<string, ModelTokenPrice>();
  for (const [rawName, value] of Object.entries(rates)) {
    const parsed = priceField(rawName);
    if (!parsed) continue;
    const key = `${parsed.tier}:${parsed.condition}`;
    const current = rows.get(key) ?? {
      tier: parsed.tier,
      condition: parsed.condition,
      inputDbuPerMillionTokens: null,
      outputDbuPerMillionTokens: null,
      cacheReadDbuPerMillionTokens: null,
      cacheWriteDbuPerMillionTokens: null,
      cacheWriteOneHourDbuPerMillionTokens: null,
    };
    rows.set(key, { ...current, [parsed.field]: value });
  }
  return [...rows.values()];
}

function priceField(name: string):
  | Readonly<{
      tier: ModelTokenPrice["tier"];
      condition: ModelTokenPrice["condition"];
      field:
        | "inputDbuPerMillionTokens"
        | "outputDbuPerMillionTokens"
        | "cacheReadDbuPerMillionTokens"
        | "cacheWriteDbuPerMillionTokens"
        | "cacheWriteOneHourDbuPerMillionTokens";
    }>
  | undefined {
  let remaining = name;
  const tier = remaining.startsWith("priority_pay_per_token_") ? "priority" : "standard";
  if (tier === "priority") remaining = remaining.slice("priority_pay_per_token_".length);
  const conditions = [
    ["short_context_", "short-context"],
    ["long_context_", "long-context"],
    ["text_tokens_", "text-tokens"],
    ["image_tokens_", "image-tokens"],
    ["audio_tokens_", "audio-tokens"],
  ] as const;
  const matched = conditions.find(([prefix]) => remaining.startsWith(prefix));
  const condition: ModelTokenPrice["condition"] = matched?.[1] ?? "default";
  if (matched) remaining = remaining.slice(matched[0].length);
  const fields = {
    input: "inputDbuPerMillionTokens",
    output: "outputDbuPerMillionTokens",
    cache_read: "cacheReadDbuPerMillionTokens",
    cache_write: "cacheWriteDbuPerMillionTokens",
    cache_write_1hr: "cacheWriteOneHourDbuPerMillionTokens",
  } as const;
  const field = fields[remaining as keyof typeof fields];
  return field ? { tier, condition, field } : undefined;
}

function catalogRatings(records: readonly CatalogModelRecord[]): Readonly<{
  byId: ReadonlyMap<string, ModelRating>;
  byKey: Record<string, ModelRating>;
}> {
  const maximumRanks = new Map<string, number>();
  for (const record of records) {
    for (const ranking of record.rankings) {
      if (ranking.category !== "overall" || !ranking.published_at) continue;
      maximumRanks.set(
        ranking.domain,
        Math.max(maximumRanks.get(ranking.domain) ?? 0, ranking.rank),
      );
    }
  }
  const byId = new Map<string, ModelRating>();
  for (const record of records) {
    const rankings: Record<string, ModelRanking> = {};
    for (const ranking of record.rankings) {
      if (ranking.category !== "overall" || !ranking.published_at) continue;
      rankings[ranking.domain] =
        ranking.metric === "rating"
          ? {
              score: ranking.rating,
              lowerBound: ranking.lower,
              upperBound: ranking.upper,
              variance: ranking.variance,
              voteCount: ranking.votes,
              rank: ranking.rank,
              publishedAt: `${ranking.published_at}T00:00:00.000Z`,
            }
          : {
              score: ranking.score,
              lowerBound: ranking.lower,
              upperBound: ranking.upper,
              observationCount: ranking.observations,
              ...(ranking.sessions === null ? {} : { sessionCount: ranking.sessions }),
              rank: ranking.rank,
              publishedAt: `${ranking.published_at}T00:00:00.000Z`,
            };
    }
    const values = Object.entries(rankings);
    if (!values.length) continue;
    const score =
      values.reduce(
        (total, [domain, ranking]) =>
          total + rankPercentile(ranking.rank, maximumRanks.get(domain) ?? ranking.rank),
        0,
      ) / values.length;
    byId.set(record.id, { score: Math.round(score * 1_000) / 1_000, rankings });
  }
  return { byId, byKey: {} };
}

function rankPercentile(rank: number, maximumRank: number): number {
  if (maximumRank <= 1) return 100;
  return Math.max(0, Math.min(100, (1 - (rank - 1) / (maximumRank - 1)) * 100));
}
