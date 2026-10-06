/**
 * Build-generated Databricks model retirement, capability, rate-limit, and
 * reasoning-effort metadata, plus a daily write-through cache for refreshed
 * docs and error-learned reasoning ladders.
 *
 * Committed snapshots seed every process. {@link refreshModelMetadata} pulls
 * documentation through {@link createMetadataCache} (cacache memoize + disk) and
 * rebuilds the in-memory index. Error-learned efforts use the same store via
 * {@link rememberReasoningLevels}. Disk writes are skipped in Databricks Apps.
 *
 * @module
 */
import * as functionUtils from "@dbx-tools/shared-core/function-utils";
import type {
  ModelCapabilities,
  ModelMetadata,
  ModelRateLimits,
  ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";

import {
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  QUERY_REASON_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
  type ModelCapabilitiesSnapshot,
  type ModelCapabilityCatalogue,
  type ModelRateLimitsSnapshot,
  type ReasoningModelsSnapshot,
} from "./_metadata-contract.ts";
import {
  parseModelCapabilities,
  parseModelRateLimits,
  parseReasoningModels,
  parseRetiredModels,
} from "./_metadata-generator.ts";
import {
  COMMITTED_RETIRED_MODELS,
  modelStatusFor,
  replaceRetiredModelNames,
  RETIRED_MODELS_GENERATED_AT,
} from "./_retirement.ts";
import capabilitiesSnapshotJson from "./generated/model-capabilities.json" with { type: "json" };
import rateLimitsSnapshotJson from "./generated/model-rate-limits.json" with { type: "json" };
import reasoningSnapshotJson from "./generated/model-reasoning.json" with { type: "json" };
import {
  createMetadataCache,
  mergePreferFreshList,
  mergePreferFreshRecord,
  type MetadataCache,
} from "./metadata-cache.ts";
import { inheritsNativeWebSearch, isFoundationModelIdentity, modelSearchQuery } from "./policy.ts";
import {
  defaultReasoningLevels,
  documentedReasoningLevels,
  parseReasoning,
  parseReasoningLevels,
  type ReasoningLevel,
  type ReasoningModelCatalogue,
  uniqueReasoningLevels,
} from "./reasoning-translation.ts";

export {
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  QUERY_REASON_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
};

const capabilitiesSnapshot = capabilitiesSnapshotJson as ModelCapabilitiesSnapshot;
const rateLimitsSnapshot = rateLimitsSnapshotJson as ModelRateLimitsSnapshot;
const reasoningSnapshot = reasoningSnapshotJson as ReasoningModelsSnapshot;

interface MetadataIndex {
  readonly capabilities: {
    readonly [Key in keyof ModelCapabilityCatalogue]: ReadonlySet<string>;
  };
  readonly rateLimits: ReadonlyMap<string, ModelRateLimits>;
  readonly reasoning: ReasoningModelCatalogue;
  readonly learnedReasoning: ReasoningModelCatalogue;
}

type CapabilitySets = ModelCapabilityCatalogue;

const USER_AGENT = "dbx-tools-model-metadata/1";

const retiredCache = createMetadataCache<readonly string[]>({
  key: "retired-models",
  fallback: COMMITTED_RETIRED_MODELS,
  load: async () => parseRetiredModels(await loadPage(RETIRED_MODELS_URL), nowSeconds()).models,
  merge: mergePreferFreshList,
});

const capabilitiesCache = createMetadataCache<CapabilitySets>({
  key: "model-capabilities",
  fallback: capabilitiesSnapshot.capabilities,
  load: async () => {
    const [responsesHtml, webSearchHtml] = await Promise.all([
      loadPage(OPENAI_RESPONSES_MODELS_URL),
      loadPage(WEB_SEARCH_MODELS_URL),
    ]);
    return parseModelCapabilities(responsesHtml, webSearchHtml, nowSeconds()).capabilities;
  },
  merge: (input) => ({
    responses: mergePreferFreshList({
      fresh: input.fresh?.responses,
      previous: input.previous?.responses,
      fallback: input.fallback.responses,
    }),
    imageInput: mergePreferFreshList({
      fresh: input.fresh?.imageInput,
      previous: input.previous?.imageInput,
      fallback: input.fallback.imageInput,
    }),
    applyPatch: mergePreferFreshList({
      fresh: input.fresh?.applyPatch,
      previous: input.previous?.applyPatch,
      fallback: input.fallback.applyPatch,
    }),
    webSearch: mergePreferFreshList({
      fresh: input.fresh?.webSearch,
      previous: input.previous?.webSearch,
      fallback: input.fallback.webSearch,
    }),
  }),
});

const rateLimitsCache = createMetadataCache<Readonly<Record<string, ModelRateLimits>>>({
  key: "model-rate-limits",
  fallback: rateLimitsSnapshot.catalogue.models,
  load: async () =>
    parseModelRateLimits(await loadPage(MODEL_RATE_LIMITS_URL), nowSeconds()).catalogue.models,
  merge: mergePreferFreshRecord,
});

const reasoningDocsCache = createMetadataCache<Readonly<Record<string, readonly string[]>>>({
  key: "model-reasoning",
  fallback: reasoningSnapshot.catalogue.models,
  load: async () =>
    parseReasoningModels(await loadPage(QUERY_REASON_MODELS_URL), nowSeconds()).catalogue.models,
  merge: mergePreferFreshRecord,
});

const learnedReasoningCache = createMetadataCache<
  Readonly<Record<string, readonly ReasoningLevel[]>>
>({
  key: "learned-reasoning",
  fallback: {},
  merge: mergePreferFreshRecord,
});

let liveIndex: MetadataIndex | undefined;

const metadataIndex = functionUtils.memoize<MetadataIndex>(
  () => liveIndex ?? buildIndexFromCommitted(),
);

function buildIndexFromCommitted(): MetadataIndex {
  return buildIndex({
    retiredNames: COMMITTED_RETIRED_MODELS,
    capabilities: capabilitiesSnapshot.capabilities,
    rateLimits: rateLimitsSnapshot.catalogue.models,
    reasoning: reasoningSnapshot.catalogue.models,
    learnedReasoning: {},
  });
}

function buildIndex(input: {
  readonly retiredNames: readonly string[];
  readonly capabilities: CapabilitySets;
  readonly rateLimits: Readonly<Record<string, ModelRateLimits>>;
  readonly reasoning: Readonly<Record<string, readonly string[]>>;
  readonly learnedReasoning: Readonly<Record<string, readonly ReasoningLevel[]>>;
}): MetadataIndex {
  replaceRetiredModelNames(input.retiredNames);
  return {
    capabilities: {
      responses: new Set(input.capabilities.responses),
      imageInput: new Set(input.capabilities.imageInput),
      applyPatch: new Set(input.capabilities.applyPatch),
      webSearch: new Set(input.capabilities.webSearch),
    },
    rateLimits: new Map(Object.entries(input.rateLimits)),
    reasoning: freezeReasoningCatalogue(input.reasoning),
    learnedReasoning: freezeLearnedCatalogue(input.learnedReasoning),
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
    const [retiredNames, capabilities, rateLimits, reasoning, learnedReasoning] = await Promise.all(
      [
        retiredCache.get(),
        capabilitiesCache.get(),
        rateLimitsCache.get(),
        reasoningDocsCache.get(),
        learnedReasoningCache.get(),
      ],
    );
    liveIndex = buildIndex({
      retiredNames,
      capabilities,
      rateLimits,
      reasoning,
      learnedReasoning,
    });
    return liveIndex;
  })().finally(() => {
    refreshInflight = undefined;
  });
  return refreshInflight;
}

/** Load cacache / memory entries without forcing a network refresh. */
export async function hydrateModelMetadata(): Promise<MetadataIndex> {
  const [retiredNames, capabilities, rateLimits, reasoning, learnedReasoning] = await Promise.all([
    peekOrFallback(retiredCache, COMMITTED_RETIRED_MODELS),
    peekOrFallback(capabilitiesCache, capabilitiesSnapshot.capabilities),
    peekOrFallback(rateLimitsCache, rateLimitsSnapshot.catalogue.models),
    peekOrFallback(reasoningDocsCache, reasoningSnapshot.catalogue.models),
    peekOrFallback(learnedReasoningCache, {}),
  ]);
  liveIndex = buildIndex({
    retiredNames,
    capabilities,
    rateLimits,
    reasoning,
    learnedReasoning,
  });
  return liveIndex;
}

async function peekOrFallback<T>(cache: MetadataCache<T>, fallback: T): Promise<T> {
  const peeked = await cache.peek();
  if (peeked !== undefined) return peeked;
  return cache.get().catch(() => fallback);
}

/** Absolute cacache root used by the documentation / learned caches. */
export function modelMetadataCachePath(): string {
  return retiredCache.path;
}

export { modelStatusFor, retiredModelNames } from "./_retirement.ts";

/** Return the committed reasoning-effort catalogue. Cached per process. */
export function reasoningModelCatalogue(): ReasoningModelCatalogue {
  return metadataIndex().reasoning;
}

/** Return error-learned reasoning ladders persisted in the metadata cache. */
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
 * Returns the levels that were stored (or the current lookup when parse yields
 * nothing). The raw error body is never written to disk.
 */
export async function learnReasoningLevelsFromError(
  model: string,
  body: unknown,
): Promise<ReasoningLevel[]> {
  return rememberReasoningLevels(model, parseReasoningLevels(body));
}

/** Resolve documented model capabilities from a name or endpoint summary. */
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
  };
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

/**
 * Resolve reasoning levels: learned from errors, then documentation, then
 * family defaults.
 *
 * Does not parse error bodies; callers should use {@link parseReasoningLevels}
 * and then {@link rememberReasoningLevels}.
 */
export function modelReasoningLevelsFor(model: string | ServingEndpointSummary): ReasoningLevel[] {
  const index = metadataIndex();
  for (const identity of modelIdentities(model)) {
    const learned = documentedReasoningLevels(identity, index.learnedReasoning);
    if (learned?.length) return learned;
  }
  for (const identity of modelIdentities(model)) {
    const documented = documentedReasoningLevels(identity, index.reasoning);
    if (documented?.length) return documented;
  }
  const primary = typeof model === "string" ? model : (model.modelServiceName ?? model.name);
  return defaultReasoningLevels(primary);
}

/** Resolve retirement, capability, and rate-limit metadata together. */
export function modelMetadataFor(model: string | ServingEndpointSummary): ModelMetadata {
  const rateLimits = modelRateLimitsFor(model);
  return {
    status: modelStatusFor(model),
    capabilities: modelCapabilitiesFor(model),
    ...(rateLimits ? { rateLimits } : {}),
  };
}

/** Return generation timestamps for the committed metadata snapshots. */
export function modelMetadataGeneratedAt(): Readonly<{
  retiredModels: number;
  capabilities: number;
  rateLimits: number;
  reasoning: number;
}> {
  return {
    retiredModels: RETIRED_MODELS_GENERATED_AT,
    capabilities: capabilitiesSnapshot.generatedAt,
    rateLimits: rateLimitsSnapshot.generatedAt,
    reasoning: reasoningSnapshot.generatedAt,
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

function modelKey(value: string): string | undefined {
  return modelSearchQuery(value)?.replaceAll(" ", "-");
}

async function loadPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Databricks documentation returned HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
