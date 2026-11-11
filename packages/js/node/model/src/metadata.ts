/**
 * Public model metadata adapted from @dbx-tools/dbx-model-catalog, plus a
 * write-through cache for error-learned reasoning ladders.
 *
 * The bundled public catalog seeds every process. {@link refreshModelMetadata}
 * downloads the current public catalog publication. Workspace endpoint
 * discovery and error-learned efforts remain owned by this package.
 *
 * @module
 */
import { memoize } from "@dbx-tools/shared-core";
import { loadModelCatalog } from "@dbx-tools/dbx-model-catalog/browser";
import {
  bundledModelCatalogIndex,
  createModelCatalogIndex,
} from "@dbx-tools/dbx-model-catalog/snapshot";
import type {
  ModelCapabilities,
  ModelLatencyScore,
  ModelMetadata,
  ModelRating,
  ModelRateLimits,
  ModelTokenPrice,
  ServingEndpointSummary,
} from "@dbx-tools/shared-model";

import { metadataFromCatalog, type CatalogMetadataInput } from "./_catalog-metadata.ts";
import { compareVersionTuples, versionTuple } from "./classify.ts";
import modelsDevSnapshotJson from "./generated/models-dev-capabilities.json" with { type: "json" };
import { createMetadataCache, mergePreferFreshRecord } from "./metadata-cache.ts";
import { ModelsDevSnapshotSchema } from "./metadata-contract.ts";
import {
  inheritsNativeWebSearch,
  isFoundationModelIdentity,
  modelFamily,
  modelReasoningEfforts,
  modelSearchQuery,
  modelSupportsTools,
} from "./policy.ts";
import {
  defaultReasoningLevels,
  documentedReasoningLevels,
  parseReasoning,
  parseReasoningLevels,
  type ReasoningLevel,
  type ReasoningModelCatalogue,
  uniqueReasoningLevels,
} from "./reasoning-translation.ts";
import { modelStatusFor, replaceRetiredModelNames } from "./retirement.ts";

interface MetadataIndex {
  readonly capabilities: {
    readonly [Key in keyof ModelCapabilities]: ReadonlySet<string>;
  };
  readonly rateLimits: ReadonlyMap<string, ModelRateLimits>;
  readonly tokenPrices: ReadonlyMap<string, readonly ModelTokenPrice[]>;
  readonly latencyScores: ReadonlyMap<string, ModelLatencyScore>;
  readonly ratings: ReadonlyMap<string, ModelRating>;
  readonly reasoning: ReasoningModelCatalogue;
  readonly reasoningDocs: ReasoningModelCatalogue;
  readonly modelParamsReasoning: ReasoningModelCatalogue;
  readonly learnedReasoning: ReasoningModelCatalogue;
  readonly temperatureUnsupported: ReadonlySet<string>;
}

type CapabilitySets = CatalogMetadataInput["capabilities"];
type ModelsDevData = CatalogMetadataInput["modelsDev"];
type CatalogSnapshot = Readonly<{
  catalog: Parameters<typeof createModelCatalogIndex>[0];
  searchIndex: Parameters<typeof createModelCatalogIndex>[1];
}>;

const compatibilityModelsDev = ModelsDevSnapshotSchema.parse(modelsDevSnapshotJson).capabilities;

function catalogMetadata(index: Parameters<typeof metadataFromCatalog>[0]): CatalogMetadataInput {
  return metadataFromCatalog(index, { modelsDev: compatibilityModelsDev });
}

/** Token counts used to estimate one Databricks model invocation. */
export interface ModelTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWriteOneHourTokens?: number;
}

/** Select one documented Databricks price row and optional currency conversion. */
export interface EstimateModelTokenPriceOptions {
  readonly tier?: ModelTokenPrice["tier"];
  readonly condition?: ModelTokenPrice["condition"];
  readonly usdPerDbu?: number;
}

/** Estimated DBU and optional USD price for one model invocation. */
export interface ModelTokenPriceEstimate {
  readonly model: string;
  readonly rate: ModelTokenPrice;
  readonly price: Readonly<{
    dbu: number;
    usd?: number;
  }>;
}

const catalogCache = createMetadataCache<CatalogSnapshot>({
  key: "public-model-catalog-v16",
  fallback: {
    catalog: bundledModelCatalogIndex.catalog,
    searchIndex: bundledModelCatalogIndex.searchIndex,
  },
  load: async () => {
    const client = await loadModelCatalog();
    try {
      const [catalog, searchIndex] = await Promise.all([client.catalog(), client.searchIndex()]);
      return { catalog, searchIndex };
    } finally {
      client.close();
    }
  },
  merge: ({ fresh, previous, fallback }) => fresh ?? previous ?? fallback,
});

const learnedReasoningCache = createMetadataCache<
  Readonly<Record<string, readonly ReasoningLevel[]>>
>({
  key: "learned-reasoning",
  fallback: {},
  merge: mergePreferFreshRecord,
});

let liveIndex: MetadataIndex | undefined;

const committedMetadataIndex = memoize<MetadataIndex>(buildIndexFromCommitted);

function metadataIndex(): MetadataIndex {
  return liveIndex ?? committedMetadataIndex();
}

function buildIndexFromCommitted(): MetadataIndex {
  return buildIndex({ ...catalogMetadata(bundledModelCatalogIndex), learnedReasoning: {} });
}

function buildIndex(input: {
  readonly retiredNames: readonly string[];
  readonly capabilities: CapabilitySets;
  readonly modelsDev: ModelsDevData;
  readonly modelParams: CatalogMetadataInput["modelParams"];
  readonly rateLimits: Readonly<Record<string, ModelRateLimits>>;
  readonly tokenPrices: Readonly<Record<string, readonly ModelTokenPrice[]>>;
  readonly latencyScores: Readonly<Record<string, ModelLatencyScore>>;
  readonly ratings: Readonly<Record<string, ModelRating>>;
  readonly reasoning: Readonly<Record<string, readonly string[]>>;
  readonly learnedReasoning: Readonly<Record<string, readonly ReasoningLevel[]>>;
}): MetadataIndex {
  replaceRetiredModelNames(input.retiredNames);
  const reasoningDocs = freezeReasoningCatalogue(input.reasoning);
  const modelParamsReasoning = freezeReasoningCatalogue(input.modelParams.models);
  return {
    capabilities: {
      responses: new Set(input.capabilities.responses),
      imageInput: new Set([...input.capabilities.imageInput, ...input.modelsDev.imageInput]),
      applyPatch: new Set(input.capabilities.applyPatch),
      webSearch: new Set(input.capabilities.webSearch),
      reasoning: new Set([...input.modelsDev.reasoning, ...input.modelParams.reasoning]),
      tools: new Set(input.modelsDev.tools),
      structuredOutput: new Set(input.modelsDev.structuredOutput),
      temperature: new Set(input.modelsDev.temperatureSupported),
    },
    rateLimits: new Map(Object.entries(input.rateLimits)),
    tokenPrices: new Map(
      Object.entries(input.tokenPrices).map(([key, prices]) => [key, Object.freeze([...prices])]),
    ),
    latencyScores: new Map(Object.entries(input.latencyScores)),
    ratings: new Map(Object.entries(input.ratings)),
    reasoning: Object.freeze({
      ...modelParamsReasoning,
      ...reasoningDocs,
    }),
    reasoningDocs,
    modelParamsReasoning,
    learnedReasoning: freezeLearnedCatalogue(input.learnedReasoning),
    temperatureUnsupported: new Set(input.modelsDev.temperatureUnsupported),
  };
}

function freezeReasoningCatalogue(
  models: Readonly<Record<string, readonly string[]>>,
): ReasoningModelCatalogue {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(models).map(([key, levels]) => [
        key,
        Object.freeze(
          uniqueReasoningLevels(levels.flatMap((level) => parseReasoning(level) ?? [])),
        ),
      ]),
    ),
  );
}

function freezeLearnedCatalogue(
  models: Readonly<Record<string, readonly ReasoningLevel[]>>,
): ReasoningModelCatalogue {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(models).map(([key, levels]) => [
        key,
        Object.freeze(uniqueReasoningLevels(levels)),
      ]),
    ),
  );
}

let refreshInflight: Promise<MetadataIndex> | undefined;

/**
 * Hydrate or refresh documentation + learned caches into the process index.
 *
 * Safe to call on gateway startup. Concurrent callers share one refresh.
 */
export async function refreshModelMetadata(): Promise<MetadataIndex> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    const [{ catalog, searchIndex }, learnedReasoning] = await Promise.all([
      catalogCache.get(),
      learnedReasoningCache.get(),
    ]);
    liveIndex = buildIndex({
      ...catalogMetadata(createModelCatalogIndex(catalog, searchIndex)),
      learnedReasoning,
    });
    return liveIndex;
  })().finally(() => {
    refreshInflight = undefined;
  });
  return refreshInflight;
}

/** Load the bundled public catalog and locally learned reasoning levels. */
export async function hydrateModelMetadata(): Promise<MetadataIndex> {
  const [catalogSnapshot, learnedReasoning] = await Promise.all([
    catalogCache.peek().catch(() => undefined),
    learnedReasoningCache.peek().catch(() => undefined),
  ]);
  const catalog = catalogSnapshot
    ? createModelCatalogIndex(catalogSnapshot.catalog, catalogSnapshot.searchIndex)
    : bundledModelCatalogIndex;
  liveIndex = buildIndex({
    ...catalogMetadata(catalog),
    learnedReasoning: learnedReasoning ?? {},
  });
  return liveIndex;
}

/** Return the committed reasoning-effort catalogue. Cached per process. */
export function reasoningModelCatalogue(): ReasoningModelCatalogue {
  return metadataIndex().reasoning;
}

/** Return error-learned reasoning ladders from the shared model cache. */
export function learnedReasoningCatalogue(): ReasoningModelCatalogue {
  return metadataIndex().learnedReasoning;
}

/**
 * Store levels learned from an upstream error and persist them write-through.
 *
 * Empty lists are ignored so a failed parse cannot wipe defaults. Error bodies
 * themselves are never stored - only the parsed ladder.
 */
export async function rememberReasoningLevels(
  model: string,
  levels: readonly ReasoningLevel[],
): Promise<ReasoningLevel[]> {
  const unique = uniqueReasoningLevels(levels);
  if (unique.length === 0) return modelReasoningLevelsFor(model);
  const key = modelKey(model);
  if (!key) return modelReasoningLevelsFor(model);
  const catalogue = await learnedReasoningCache.update((current) => ({
    ...current,
    [key]: unique,
  }));
  const current = metadataIndex();
  liveIndex = {
    ...current,
    learnedReasoning: freezeLearnedCatalogue(catalogue),
  };
  return [...unique];
}

/**
 * Parse an upstream error body and persist the supported ladder for `model`.
 *
 * Accepts the same nested Databricks envelopes as {@link parseReasoningLevels}.
 * Returns a published ladder without parsing or storing error-derived levels
 * when one exists. Otherwise returns the levels that were stored, or the
 * current fallback when parsing yields nothing. The raw error body is never
 * cached.
 */
export async function learnReasoningLevelsFromError(
  model: string,
  body: unknown,
): Promise<ReasoningLevel[]> {
  const published = publishedReasoningLevelsFor(model, metadataIndex());
  if (published) return published;
  return rememberReasoningLevels(model, parseReasoningLevels(body));
}

/** Resolve published model capabilities from a name or endpoint summary. */
export function modelCapabilitiesFor(model: string | ServingEndpointSummary): ModelCapabilities {
  const capabilities = metadataIndex().capabilities;
  const identities = modelIdentities(model, false);
  const keys = identities.flatMap((identity) => modelKey(identity) ?? []);
  return {
    responses: keys.some((key) => capabilities.responses.has(key)),
    imageInput: keys.some((key) => capabilities.imageInput.has(key)),
    applyPatch: keys.some((key) => capabilities.applyPatch.has(key)),
    // Version inheritance only applies to hosted foundation identities.
    webSearch:
      keys.some((key) => capabilities.webSearch.has(key)) ||
      identities.some(
        (identity) =>
          isFoundationModelIdentity(identity) &&
          inheritsNativeWebSearch(identity, capabilities.webSearch),
      ),
    reasoning:
      keys.some((key) => capabilities.reasoning.has(key)) ||
      identities.some((identity) => modelReasoningEfforts(identity).length > 0),
    tools: keys.some((key) => capabilities.tools.has(key)) || identities.some(modelSupportsTools),
    structuredOutput: keys.some((key) => capabilities.structuredOutput.has(key)),
    temperature: modelTemperatureSupportFor(model) === true,
  };
}

/** Resolve explicit Databricks temperature support, or undefined when unpublished. */
export function modelTemperatureSupportFor(
  model: string | ServingEndpointSummary,
): boolean | undefined {
  const index = metadataIndex();
  const keys = modelIdentities(model).flatMap((identity) => modelKey(identity) ?? []);
  if (keys.some((key) => index.temperatureUnsupported.has(key))) return false;
  if (keys.some((key) => index.capabilities.temperature.has(key))) return true;
  return undefined;
}

/** Resolve published ITPM, OTPM, and QPH limits from a model identity. */
export function modelRateLimitsFor(
  model: string | ServingEndpointSummary,
): ModelRateLimits | undefined {
  const limits = metadataIndex().rateLimits;
  for (const identity of modelIdentities(model)) {
    const key = modelKey(identity);
    if (!key) continue;
    const found = limits.get(key);
    if (found) return found;
  }
  return undefined;
}

/** Resolve Databricks DBU rates per million tokens from a model identity. */
export function modelTokenPricesFor(
  model: string | ServingEndpointSummary,
): readonly ModelTokenPrice[] | undefined {
  const prices = metadataIndex().tokenPrices;
  const keys = modelIdentities(model).flatMap(pricingLookupKeys);
  for (const key of keys) {
    const exact = prices.get(key);
    if (exact) return exact;
  }
  for (const key of keys) {
    const compatible = [...prices.entries()]
      .filter(([candidate]) => compatiblePricingKeys(key, candidate))
      .sort(([left], [right]) => right.length - left.length)[0];
    if (compatible) return compatible[1];
  }
  return undefined;
}

/** Resolve the committed normalized latency score for one model identity. */
export function modelLatencyScoreFor(
  model: string | ServingEndpointSummary,
): ModelLatencyScore | undefined {
  const catalogue = metadataIndex().latencyScores;
  const identities = modelIdentities(model);
  for (const identity of identities) {
    const key = modelKey(identity);
    if (key && catalogue.has(key)) return catalogue.get(key);
  }
  for (const identity of identities) {
    const inherited = inheritedModelValue(identity, catalogue);
    if (inherited) return inherited;
  }
  return undefined;
}

/** Resolve the committed Arena human-preference rating for one model identity. */
export function modelRatingFor(model: string | ServingEndpointSummary): ModelRating | undefined {
  const catalogue = metadataIndex().ratings;
  const identities = modelIdentities(model);
  for (const identity of identities) {
    const key = modelKey(identity);
    if (key && catalogue.has(key)) return catalogue.get(key);
  }
  for (const identity of identities) {
    const inherited = inheritedModelValue(identity, catalogue);
    if (inherited) return inherited;
  }
  return undefined;
}

/** Estimate invocation price from documented Databricks token rates. */
export function estimateModelTokenPrice(
  model: string | ServingEndpointSummary,
  usage: ModelTokenUsage,
  options: EstimateModelTokenPriceOptions = {},
): ModelTokenPriceEstimate | undefined {
  const rates = modelTokenPricesFor(model);
  if (!rates) return undefined;
  const tier = options.tier ?? "standard";
  const tierRates = rates.filter((rate) => rate.tier === tier);
  const rate = options.condition
    ? tierRates.find((candidate) => candidate.condition === options.condition)
    : (tierRates.find((candidate) => candidate.condition === "default") ??
      tierRates.find((candidate) => candidate.condition === "short-context") ??
      tierRates[0]);
  if (!rate) return undefined;
  const tokenCounts = {
    inputDbuPerMillionTokens: tokenCount(usage.inputTokens, "inputTokens"),
    outputDbuPerMillionTokens: tokenCount(usage.outputTokens, "outputTokens"),
    cacheReadDbuPerMillionTokens: tokenCount(usage.cacheReadTokens, "cacheReadTokens"),
    cacheWriteDbuPerMillionTokens: tokenCount(usage.cacheWriteTokens, "cacheWriteTokens"),
    cacheWriteOneHourDbuPerMillionTokens: tokenCount(
      usage.cacheWriteOneHourTokens,
      "cacheWriteOneHourTokens",
    ),
  } as const;
  let dbu = 0;
  for (const [field, tokens] of Object.entries(tokenCounts) as Array<
    [keyof typeof tokenCounts, number]
  >) {
    if (tokens === 0) continue;
    const dbuPerMillionTokens = rate[field];
    if (dbuPerMillionTokens === null) return undefined;
    dbu += (tokens / 1_000_000) * dbuPerMillionTokens;
  }
  const usdPerDbu = optionalNonnegativeNumber(options.usdPerDbu, "usdPerDbu");
  return {
    model: typeof model === "string" ? model : (model.modelServiceName ?? model.name),
    rate,
    price: {
      dbu,
      ...(usdPerDbu === undefined ? {} : { usd: dbu * usdPerDbu }),
    },
  };
}

/**
 * Resolve reasoning levels: published catalog metadata, learned errors, then
 * family defaults.
 *
 * Does not parse error bodies; callers handling an upstream error should use
 * {@link learnReasoningLevelsFromError} so published levels keep precedence.
 */
export function modelReasoningLevelsFor(model: string | ServingEndpointSummary): ReasoningLevel[] {
  const index = metadataIndex();
  const published = publishedReasoningLevelsFor(model, index);
  if (published) return published;
  for (const identity of modelIdentities(model)) {
    const learned = documentedReasoningLevels(identity, index.learnedReasoning);
    if (learned?.length) return learned;
  }
  const primary = typeof model === "string" ? model : (model.modelServiceName ?? model.name);
  return defaultReasoningLevels(primary);
}

function publishedReasoningLevelsFor(
  model: string | ServingEndpointSummary,
  index: MetadataIndex,
): ReasoningLevel[] | undefined {
  const identities = modelIdentities(model);
  for (const identity of identities) {
    const documented = documentedReasoningLevels(identity, index.reasoningDocs);
    if (documented?.length) return documented;
  }
  for (const identity of identities) {
    const modelParams = documentedReasoningLevels(identity, index.modelParamsReasoning);
    if (modelParams?.length) return modelParams;
  }
  return undefined;
}

/** Resolve retirement, capability, latency, rate-limit, and price metadata together. */
export function modelMetadataFor(model: string | ServingEndpointSummary): ModelMetadata {
  const rateLimits = modelRateLimitsFor(model);
  const tokenPrices = modelTokenPricesFor(model);
  const latencyScore = modelLatencyScoreFor(model);
  const rating = modelRatingFor(model);
  return {
    status: modelStatusFor(model),
    capabilities: modelCapabilitiesFor(model),
    ...(latencyScore ? { latencyScore } : {}),
    ...(rating ? { rating } : {}),
    ...(rateLimits ? { rateLimits } : {}),
    ...(tokenPrices ? { tokenPrices: [...tokenPrices] } : {}),
  };
}

/** Return the public catalog timestamp for each compatibility metadata field. */
export function modelMetadataGeneratedAt(): Readonly<{
  retiredModels: number;
  capabilities: number;
  modelsDev: number;
  modelParams: number;
  rateLimits: number;
  tokenPrices: number;
  latency: number;
  ratings: number;
  reasoning: number;
}> {
  const generatedAt = Math.floor(
    new Date(bundledModelCatalogIndex.catalog.updated_at).getTime() / 1_000,
  );
  return {
    retiredModels: generatedAt,
    capabilities: generatedAt,
    modelsDev: generatedAt,
    modelParams: generatedAt,
    rateLimits: generatedAt,
    tokenPrices: generatedAt,
    latency: generatedAt,
    ratings: generatedAt,
    reasoning: generatedAt,
  };
}

function modelIdentities(
  model: string | ServingEndpointSummary,
  includeDisplayName = true,
): string[] {
  if (typeof model === "string") return [model];
  return [
    model.name,
    ...(includeDisplayName ? [model.displayName] : []),
    model.modelServiceName,
    ...Object.values(model.serviceNames ?? {}),
  ].filter((value): value is string => Boolean(value));
}

function inheritedModelValue<T>(
  identity: string,
  catalogue: ReadonlyMap<string, T>,
): T | undefined {
  const key = modelKey(identity);
  const family = modelFamily(identity);
  const variant = modelVariant(identity);
  const targetVersion = versionTuple(identity);
  if (!key || !family || !variant || targetVersion.every((value) => value === 0)) return undefined;
  const candidates = [...catalogue.entries()]
    .filter(([candidate]) => {
      if (modelFamily(candidate) !== family || modelVariant(candidate) !== variant) return false;
      const version = versionTuple(candidate);
      return (
        !version.every((value) => value === 0) && compareVersionTuples(targetVersion, version) >= 0
      );
    })
    .sort(([left], [right]) => compareVersionTuples(versionTuple(right), versionTuple(left)));
  return candidates[0]?.[1];
}

function modelVariant(identity: string): string | undefined {
  const query = modelSearchQuery(identity);
  if (!query) return undefined;
  const [family, ...tokens] = query.split(" ");
  return `${family}:${tokens.filter((token) => !/^\d+$/.test(token)).join("-")}`;
}

function pricingLookupKeys(identity: string): string[] {
  const keys = new Set<string>();
  const normalized = modelKey(identity);
  if (normalized) keys.add(normalized);
  const literal = identity
    .toLowerCase()
    .replace(/^system\.ai[.-]/, "")
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (literal) keys.add(literal);
  return [...keys];
}

function compatiblePricingKeys(left: string, right: string): boolean {
  if (left.startsWith(`${right}-`) || right.startsWith(`${left}-`)) return true;
  const leftTokens = new Set(left.split("-"));
  const rightTokens = new Set(right.split("-"));
  const smaller = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
  const larger = smaller === leftTokens ? rightTokens : leftTokens;
  return smaller.size >= 3 && [...smaller].every((token) => larger.has(token));
}

function tokenCount(value: number | undefined, field: string): number {
  const count = optionalNonnegativeNumber(value, field) ?? 0;
  if (!Number.isInteger(count)) throw new RangeError(`${field} must be an integer`);
  return count;
}

function optionalNonnegativeNumber(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a nonnegative finite number`);
  }
  return value;
}

function modelKey(value: string): string | undefined {
  return modelSearchQuery(value)?.replaceAll(" ", "-");
}
