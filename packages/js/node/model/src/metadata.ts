/**
 * Build-generated Databricks and public model capability metadata, plus a
 * daily write-through cache for refreshed sources and error-learned reasoning
 * ladders.
 *
 * Committed snapshots seed every process. {@link refreshModelMetadata} pulls
 * Databricks documentation, models.dev, and modelparams.dev through the shared
 * memory-first {@link createMetadataCache} and rebuilds the in-memory index.
 * Error-learned efforts use the same store via {@link rememberReasoningLevels}.
 * Known-good values are written behind to the shared model project cache.
 *
 * @module
 */
import { memoize } from "@dbx-tools/shared-core";
import type {
  ModelCapabilities,
  ModelMetadata,
  ModelRateLimits,
  ServingEndpointSummary,
} from "@dbx-tools/shared-model";

import {
  parseModelParams,
  parseModelCapabilities,
  parseModelRateLimits,
  parseModelsDev,
  parseReasoningModels,
  parseRetiredModels,
} from "./_metadata-generator.ts";
import capabilitiesSnapshotJson from "./generated/model-capabilities.json" with { type: "json" };
import modelParamsSnapshotJson from "./generated/modelparams-reasoning.json" with { type: "json" };
import modelsDevSnapshotJson from "./generated/models-dev-capabilities.json" with { type: "json" };
import rateLimitsSnapshotJson from "./generated/model-rate-limits.json" with { type: "json" };
import reasoningSnapshotJson from "./generated/model-reasoning.json" with { type: "json" };
import {
  createMetadataCache,
  mergePreferFreshList,
  mergePreferFreshRecord,
  type MetadataCache,
} from "./metadata-cache.ts";
import {
  MODELPARAMS_DEV_MODELS_URL,
  MODELS_DEV_API_URL,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  QUERY_REASON_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
  type ModelParamsCatalogue,
  type ModelParamsSnapshot,
  type ModelCapabilitiesSnapshot,
  type ModelCapabilityCatalogue,
  type ModelRateLimitsSnapshot,
  type ModelsDevCapabilityCatalogue,
  type ModelsDevSnapshot,
  type ReasoningModelsSnapshot,
} from "./metadata-contract.ts";
import {
  inheritsNativeWebSearch,
  isFoundationModelIdentity,
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
import {
  COMMITTED_RETIRED_MODELS,
  modelStatusFor,
  replaceRetiredModelNames,
  RETIRED_MODELS_GENERATED_AT,
} from "./retirement.ts";

const capabilitiesSnapshot = capabilitiesSnapshotJson as ModelCapabilitiesSnapshot;
const modelParamsSnapshot = modelParamsSnapshotJson as ModelParamsSnapshot;
const modelsDevSnapshot = modelsDevSnapshotJson as ModelsDevSnapshot;
const rateLimitsSnapshot = rateLimitsSnapshotJson as ModelRateLimitsSnapshot;
const reasoningSnapshot = reasoningSnapshotJson as ReasoningModelsSnapshot;

interface MetadataIndex {
  readonly capabilities: {
    readonly [Key in keyof ModelCapabilities]: ReadonlySet<string>;
  };
  readonly rateLimits: ReadonlyMap<string, ModelRateLimits>;
  readonly reasoning: ReasoningModelCatalogue;
  readonly reasoningDocs: ReasoningModelCatalogue;
  readonly modelParamsReasoning: ReasoningModelCatalogue;
  readonly learnedReasoning: ReasoningModelCatalogue;
}

type CapabilitySets = ModelCapabilityCatalogue;
type ModelsDevData = ModelsDevCapabilityCatalogue;

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

const modelsDevCache = createMetadataCache<ModelsDevData>({
  key: "models-dev-capabilities",
  fallback: modelsDevSnapshot.capabilities,
  load: async () => {
    const snapshot = parseModelsDev(await loadJson(MODELS_DEV_API_URL), nowSeconds());
    return snapshot.capabilities;
  },
  merge: mergeModelsDevData,
});

const modelParamsCache = createMetadataCache<ModelParamsCatalogue>({
  key: "modelparams-reasoning",
  fallback: modelParamsSnapshot.catalogue,
  load: async () =>
    parseModelParams(await loadJson(MODELPARAMS_DEV_MODELS_URL), nowSeconds()).catalogue,
  merge: (input) => ({
    reasoning: mergePreferFreshList({
      fresh: input.fresh?.reasoning,
      previous: input.previous?.reasoning,
      fallback: input.fallback.reasoning,
    }),
    models: mergePreferFreshRecord({
      fresh: input.fresh?.models,
      previous: input.previous?.models,
      fallback: input.fallback.models,
    }),
  }),
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
  return buildIndex({
    retiredNames: COMMITTED_RETIRED_MODELS,
    capabilities: capabilitiesSnapshot.capabilities,
    modelsDev: modelsDevSnapshot.capabilities,
    modelParams: modelParamsSnapshot.catalogue,
    rateLimits: rateLimitsSnapshot.catalogue.models,
    reasoning: reasoningSnapshot.catalogue.models,
    learnedReasoning: {},
  });
}

function buildIndex(input: {
  readonly retiredNames: readonly string[];
  readonly capabilities: CapabilitySets;
  readonly modelsDev: ModelsDevData;
  readonly modelParams: ModelParamsCatalogue;
  readonly rateLimits: Readonly<Record<string, ModelRateLimits>>;
  readonly reasoning: Readonly<Record<string, readonly string[]>>;
  readonly learnedReasoning: Readonly<Record<string, readonly ReasoningLevel[]>>;
}): MetadataIndex {
  replaceRetiredModelNames(input.retiredNames);
  const reasoningDocs = freezeReasoningCatalogue(input.reasoning);
  const modelParamsReasoning = freezeReasoningCatalogue(input.modelParams.models);
  return {
    capabilities: {
      responses: new Set(input.capabilities.responses),
      imageInput: new Set([
        ...input.capabilities.imageInput,
        ...input.modelsDev.imageInput,
      ]),
      applyPatch: new Set(input.capabilities.applyPatch),
      webSearch: new Set(input.capabilities.webSearch),
      reasoning: new Set([
        ...input.modelsDev.reasoning,
        ...input.modelParams.reasoning,
      ]),
      tools: new Set(input.modelsDev.tools),
      structuredOutput: new Set(input.modelsDev.structuredOutput),
    },
    rateLimits: new Map(Object.entries(input.rateLimits)),
    reasoning: Object.freeze({
      ...modelParamsReasoning,
      ...reasoningDocs,
    }),
    reasoningDocs,
    modelParamsReasoning,
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
    const [
      retiredNames,
      capabilities,
      modelsDev,
      modelParams,
      rateLimits,
      reasoning,
      learnedReasoning,
    ] = await Promise.all([
      retiredCache.get(),
      capabilitiesCache.get(),
      modelsDevCache.get(),
      modelParamsCache.get(),
      rateLimitsCache.get(),
      reasoningDocsCache.get(),
      learnedReasoningCache.get(),
    ]);
    liveIndex = buildIndex({
      retiredNames,
      capabilities,
      modelsDev,
      modelParams,
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

/** Load shared cache entries without forcing a network refresh. */
export async function hydrateModelMetadata(): Promise<MetadataIndex> {
  const [
    retiredNames,
    capabilities,
    modelsDev,
    modelParams,
    rateLimits,
    reasoning,
    learnedReasoning,
  ] = await Promise.all([
    peekOrFallback(retiredCache, COMMITTED_RETIRED_MODELS),
    peekOrFallback(capabilitiesCache, capabilitiesSnapshot.capabilities),
    peekOrFallback(modelsDevCache, modelsDevSnapshot.capabilities),
    peekOrFallback(modelParamsCache, modelParamsSnapshot.catalogue),
    peekOrFallback(rateLimitsCache, rateLimitsSnapshot.catalogue.models),
    peekOrFallback(reasoningDocsCache, reasoningSnapshot.catalogue.models),
    peekOrFallback(learnedReasoningCache, {}),
  ]);
  liveIndex = buildIndex({
    retiredNames,
    capabilities,
    modelsDev,
    modelParams,
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
    tools:
      keys.some((key) => capabilities.tools.has(key)) || identities.some(modelSupportsTools),
    structuredOutput: keys.some((key) => capabilities.structuredOutput.has(key)),
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
 * Resolve reasoning levels: Databricks documentation, modelparams.dev,
 * learned errors, then family defaults.
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
  modelsDev: number;
  modelParams: number;
  rateLimits: number;
  reasoning: number;
}> {
  return {
    retiredModels: RETIRED_MODELS_GENERATED_AT,
    capabilities: capabilitiesSnapshot.generatedAt,
    modelsDev: modelsDevSnapshot.generatedAt,
    modelParams: modelParamsSnapshot.generatedAt,
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

async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Model metadata source returned HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

function mergeModelsDevData(input: {
  readonly fresh: ModelsDevData | undefined;
  readonly previous: ModelsDevData | undefined;
  readonly fallback: ModelsDevData;
}): ModelsDevData {
  const capability = (key: keyof ModelsDevCapabilityCatalogue) =>
    mergePreferFreshList({
      fresh: input.fresh?.[key],
      previous: input.previous?.[key],
      fallback: input.fallback[key],
    });
  return {
    imageInput: capability("imageInput"),
    reasoning: capability("reasoning"),
    tools: capability("tools"),
    structuredOutput: capability("structuredOutput"),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
