/**
 * Direct access to the public model catalog plus locally learned reasoning ladders.
 *
 * Public model records, capabilities, lifecycle, rankings, latency, limits, and
 * prices remain owned by `@dbx-tools/dbx-model-catalog`. This package owns only
 * workspace identity matching, limited newer-version policy inheritance, price
 * estimation, and error-learned reasoning state.
 *
 * @module
 */
import { connectModelCatalog } from "@dbx-tools/dbx-model-catalog";
import type {
  CatalogModelRecord,
  Latency,
  Price,
  Rankings,
  Rankings1,
  RateLimits,
} from "@dbx-tools/dbx-model-catalog/browser";
import {
  bundledModelCatalogIndex,
  createModelCatalogIndex,
  type ModelCatalogIndex,
} from "@dbx-tools/dbx-model-catalog/snapshot";
import type { ServingEndpointSummary } from "@dbx-tools/shared-model";

import { compareVersionTuples, versionTuple } from "./classify.ts";
import { createMetadataCache, mergePreferFreshRecord } from "./metadata-cache.ts";
import { modelFamily, modelSearchQuery } from "./policy.ts";
import {
  defaultReasoningLevels,
  documentedReasoningLevels,
  parseReasoning,
  parseReasoningLevels,
  type ReasoningLevel,
  type ReasoningModelCatalogue,
  uniqueReasoningLevels,
} from "./reasoning-translation.ts";

type CatalogSnapshot = Readonly<{
  catalog: Parameters<typeof createModelCatalogIndex>[0];
  searchIndex: Parameters<typeof createModelCatalogIndex>[1];
}>;

interface MetadataIndex {
  readonly catalog: ModelCatalogIndex;
  readonly learnedReasoning: ReasoningModelCatalogue;
}

/** Token counts used to estimate one Databricks model invocation. */
export interface ModelTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWriteOneHourTokens?: number;
}

/** Select a cloud-specific price instead of the catalog's normalized average. */
export interface EstimateModelTokenPriceOptions {
  readonly cloud?: "aws" | "azure" | "gcp";
}

/** Estimated cost using catalog-owned DBU and USD price records. */
export interface ModelTokenPriceEstimate {
  readonly model: string;
  readonly catalog: CatalogModelRecord;
  readonly rate: Price;
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
    const session = await connectModelCatalog();
    try {
      const [catalog, searchIndex] = await Promise.all([
        session.client.catalog(),
        session.client.searchIndex(),
      ]);
      return { catalog, searchIndex };
    } finally {
      await session.close();
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
let refreshInflight: Promise<MetadataIndex> | undefined;

function metadataIndex(): MetadataIndex {
  return (
    liveIndex ?? {
      catalog: bundledModelCatalogIndex,
      learnedReasoning: {},
    }
  );
}

/** Download the current catalog and hydrate locally learned reasoning levels. */
export async function refreshModelCatalog(): Promise<ModelCatalogIndex> {
  if (!refreshInflight) {
    refreshInflight = (async () => {
      const [{ catalog, searchIndex }, learnedReasoning] = await Promise.all([
        catalogCache.get(),
        learnedReasoningCache.get(),
      ]);
      liveIndex = {
        catalog: createModelCatalogIndex(catalog, searchIndex),
        learnedReasoning: freezeLearnedCatalogue(learnedReasoning),
      };
      return liveIndex;
    })().finally(() => {
      refreshInflight = undefined;
    });
  }
  return (await refreshInflight).catalog;
}

/** Load persisted catalog and reasoning state without requiring a network refresh. */
export async function hydrateModelCatalog(): Promise<ModelCatalogIndex> {
  const [catalogSnapshot, learnedReasoning] = await Promise.all([
    catalogCache.peek().catch(() => undefined),
    learnedReasoningCache.peek().catch(() => undefined),
  ]);
  liveIndex = {
    catalog: catalogSnapshot
      ? createModelCatalogIndex(catalogSnapshot.catalog, catalogSnapshot.searchIndex)
      : bundledModelCatalogIndex,
    learnedReasoning: freezeLearnedCatalogue(learnedReasoning ?? {}),
  };
  return liveIndex.catalog;
}

/** Resolve the direct catalog record for a model identity or live endpoint. */
export function modelCatalogRecordFor(
  model: string | ServingEndpointSummary,
): CatalogModelRecord | undefined {
  if (typeof model !== "string" && model.catalog) return model.catalog;
  return metadataIndex().catalog.matchAny(modelIdentities(model))?.record;
}

/** Resolve the catalog record used for local model-selection policy. */
export function modelCatalogPolicyRecordFor(
  model: string | ServingEndpointSummary,
): CatalogModelRecord | undefined {
  const exact = modelCatalogRecordFor(model);
  if (exact) return exact;
  for (const identity of modelIdentities(model)) {
    const inherited = inheritedCatalogRecord(identity, metadataIndex().catalog.records);
    if (inherited) return inherited;
  }
  return undefined;
}

/** Resolve catalog-owned pay-per-token limits. */
export function modelRateLimitsFor(model: string | ServingEndpointSummary): RateLimits | undefined {
  return modelCatalogPolicyRecordFor(model)?.rate_limits ?? undefined;
}

/** Resolve catalog-owned latency measurements. */
export function modelLatencyFor(model: string | ServingEndpointSummary): Latency | undefined {
  return modelCatalogPolicyRecordFor(model)?.latency ?? undefined;
}

/** Resolve catalog-owned competitive rankings. */
export function modelRankingsFor(
  model: string | ServingEndpointSummary,
): readonly (Rankings | Rankings1)[] | undefined {
  return modelCatalogPolicyRecordFor(model)?.rankings;
}

/** Resolve explicit catalog temperature support, or undefined when unpublished. */
export function modelTemperatureSupportFor(
  model: string | ServingEndpointSummary,
): boolean | undefined {
  return modelCatalogPolicyRecordFor(model)?.capabilities.temperature ?? undefined;
}

/** Estimate invocation price from catalog-owned Databricks token rates. */
export function estimateModelTokenPrice(
  model: string | ServingEndpointSummary,
  usage: ModelTokenUsage,
  options: EstimateModelTokenPriceOptions = {},
): ModelTokenPriceEstimate | undefined {
  const catalog = modelCatalogPolicyRecordFor(model);
  if (!catalog) return undefined;
  const dbuRate = options.cloud ? catalog.price[options.cloud]?.DBU : catalog.average_price.DBU;
  if (!dbuRate) return undefined;
  const usdRate = options.cloud ? catalog.price[options.cloud]?.USD : catalog.average_price.USD;
  const counts = tokenCounts(usage);
  const dbu = priceForCounts(dbuRate, counts);
  if (dbu === undefined) return undefined;
  const usd = usdRate ? priceForCounts(usdRate, counts) : undefined;
  return {
    model: typeof model === "string" ? model : (model.modelServiceName ?? model.name),
    catalog,
    rate: dbuRate,
    price: {
      dbu,
      ...(usd === undefined ? {} : { usd }),
    },
  };
}

/** Return published catalog reasoning ladders keyed by stable model id. */
export function reasoningModelCatalogue(): ReasoningModelCatalogue {
  return Object.freeze(
    Object.fromEntries(
      metadataIndex().catalog.records.flatMap((record) => {
        const levels = catalogReasoningLevels(record);
        return levels?.length ? [[record.id, Object.freeze(levels)]] : [];
      }),
    ),
  );
}

/** Return error-learned reasoning ladders from the shared model cache. */
export function learnedReasoningCatalogue(): ReasoningModelCatalogue {
  return metadataIndex().learnedReasoning;
}

/** Store supported levels learned from an upstream error. */
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
  liveIndex = {
    ...metadataIndex(),
    learnedReasoning: freezeLearnedCatalogue(catalogue),
  };
  return [...unique];
}

/** Parse and store a reasoning ladder only when the catalog does not publish one. */
export async function learnReasoningLevelsFromError(
  model: string,
  body: unknown,
): Promise<ReasoningLevel[]> {
  const published = catalogReasoningLevels(modelCatalogPolicyRecordFor(model));
  if (published?.length) return published;
  return rememberReasoningLevels(model, parseReasoningLevels(body));
}

/** Resolve catalog, learned, then family-default reasoning levels. */
export function modelReasoningLevelsFor(model: string | ServingEndpointSummary): ReasoningLevel[] {
  const published = catalogReasoningLevels(modelCatalogPolicyRecordFor(model));
  if (published?.length) return published;
  for (const identity of modelIdentities(model)) {
    const learned = documentedReasoningLevels(identity, metadataIndex().learnedReasoning);
    if (learned?.length) return learned;
  }
  const primary = typeof model === "string" ? model : (model.modelServiceName ?? model.name);
  return defaultReasoningLevels(primary);
}

/** Return the active catalog publication timestamp. */
export function modelCatalogUpdatedAt(): string {
  return metadataIndex().catalog.catalog.updated_at;
}

function catalogReasoningLevels(
  record: CatalogModelRecord | undefined,
): ReasoningLevel[] | undefined {
  const reasoning = record?.capabilities.reasoning;
  if (!reasoning?.supported || !reasoning.effort?.length) return undefined;
  const levels = uniqueReasoningLevels(
    reasoning.effort.flatMap((effort) => parseReasoning(effort) ?? []),
  );
  return levels.length ? levels : undefined;
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

function modelIdentities(model: string | ServingEndpointSummary): string[] {
  if (typeof model === "string") return [model];
  return [
    model.name,
    model.displayName,
    model.modelServiceName,
    ...Object.values(model.serviceNames ?? {}),
  ].filter((value): value is string => Boolean(value));
}

function inheritedCatalogRecord(
  identity: string,
  records: readonly CatalogModelRecord[],
): CatalogModelRecord | undefined {
  const family = modelFamily(identity);
  const variant = modelVariant(identity);
  const targetVersion = versionTuple(identity);
  if (!family || !variant || targetVersion.every((value) => value === 0)) return undefined;
  return records
    .filter((record) => {
      if (modelFamily(record.id) !== family || modelVariant(record.id) !== variant) return false;
      const version = versionTuple(record.id);
      return (
        !version.every((value) => value === 0) && compareVersionTuples(targetVersion, version) >= 0
      );
    })
    .sort((left, right) => compareVersionTuples(versionTuple(right.id), versionTuple(left.id)))[0];
}

function modelVariant(identity: string): string | undefined {
  const query = modelSearchQuery(identity);
  if (!query) return undefined;
  const [family, ...tokens] = query.split(" ");
  return `${family}:${tokens.filter((token) => !/^\d+$/.test(token)).join("-")}`;
}

function tokenCounts(usage: ModelTokenUsage): Readonly<Record<string, number>> {
  return {
    input: tokenCount(usage.inputTokens, "inputTokens"),
    output: tokenCount(usage.outputTokens, "outputTokens"),
    cache_read: tokenCount(usage.cacheReadTokens, "cacheReadTokens"),
    cache_write: tokenCount(usage.cacheWriteTokens, "cacheWriteTokens"),
    cache_write_1hr: tokenCount(usage.cacheWriteOneHourTokens, "cacheWriteOneHourTokens"),
  };
}

function priceForCounts(rate: Price, counts: Readonly<Record<string, number>>): number | undefined {
  let price = 0;
  for (const [name, tokens] of Object.entries(counts)) {
    if (tokens === 0) continue;
    const perMillionTokens = rate.rates[name];
    if (perMillionTokens === undefined) return undefined;
    price += (tokens / 1_000_000) * perMillionTokens;
  }
  return price;
}

function tokenCount(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`${field} must be a nonnegative integer`);
  }
  return value;
}

function modelKey(value: string): string | undefined {
  return modelSearchQuery(value)?.replaceAll(" ", "-");
}
