import { object, stringUtils } from "@dbx-tools/shared-core";
import {
  ModelClass as ModelClassValues,
  type ModelClass as ModelClassType,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";
import { toModelDisplayName } from "@dbx-tools/shared-model/display";
import Fuse from "fuse.js";

import { modelStatusFor } from "./_retirement.ts";
import { classesAtOrBelow, CHAT_CLASS_ORDER, isChatClass, MODEL_CLASS_ORDER } from "./classes.ts";
import {
  classifyEndpoints,
  endpointCapabilities,
  supportsToolsByFamily,
  versionTuple,
} from "./classify.ts";
import { isOpenWeightsGpt, modelFamily, modelReasoningEfforts, modelServiceNames } from "./policy.ts";

type ModelClass = ModelClassType;
const ModelClass = ModelClassValues;

const DEFAULT_FUZZY_THRESHOLD = 0.4;
const SEARCH_INTENT_FILLERS = new Set(["a", "best", "for", "model", "models", "the"]);
const CHAT_SEARCH_INTENTS = new Set([
  "chat",
  "completion",
  "completions",
  "summarize",
  "summarise",
  "summarization",
  "summarisation",
  "summary",
]);
const EMBEDDING_SEARCH_INTENTS = new Set([
  "embed",
  "embedding",
  "embeddings",
  "vector",
  "vectorize",
  "vectorise",
]);

interface NativeRankingOptions {
  readonly includeDeprecated?: boolean;
  readonly modelClass?: ModelClass;
  readonly task?: string;
}

/** Rank endpoint records through the TypeScript-owned model policy. */
export function rankEndpoints(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
  options: NativeRankingOptions = {},
): RankedModel[] {
  const filtered = endpoints.filter((endpoint) => matchesModelQuery(endpoint, query));
  const originalByName = new Map(filtered.map((endpoint) => [endpoint.name, endpoint]));
  const normalized = filtered.map((endpoint) => ({
    ...endpoint,
    ...(options.modelClass ? { class: options.modelClass } : {}),
    ...(options.task ? { task: options.task } : {}),
  }));
  const classified = options.modelClass
    ? {
        [ModelClass.ChatThinking]: [],
        [ModelClass.ChatBalanced]: [],
        [ModelClass.ChatFast]: [],
        [ModelClass.Embedding]: [],
        [options.modelClass]: normalized,
      }
    : classifyEndpoints(normalized);
  const search = query.search?.trim();
  const searchPlan = search ? modelSearchPlan(search) : undefined;
  const rankedSearch = searchPlan ? searchPlan.search : search;
  const searchIntent = searchPlan?.modelClass;
  const requestedClass = options.modelClass ?? query.modelClass ?? searchIntent;
  const includeDeprecated = query.includeDeprecated ?? options.includeDeprecated ?? false;
  const eligible = requestedClass ? classesAtOrBelow(requestedClass) : CHAT_CLASS_ORDER;
  const candidates: RankedModel[] = [];
  const explicitClass = options.modelClass ?? query.modelClass;
  if (
    searchIntent !== undefined &&
    explicitClass !== undefined &&
    isChatClass(searchIntent) !== isChatClass(explicitClass)
  ) {
    return [];
  }
  if (rankedSearch && requestedClass === undefined) {
    const classByName = classifyEndpointClasses(normalized);
    for (const endpoint of normalized) {
      if (!includeDeprecated && endpoint.status?.deprecated) continue;
      const capabilities = endpointCapabilities(endpoint);
      if (!capabilities.chat || (query.requiresTools && !capabilities.tools)) continue;
      candidates.push({
        endpoint,
        modelClass: classByName.get(endpoint.name) ?? ModelClass.ChatBalanced,
      });
    }
  } else {
    for (const modelClass of eligible) {
      for (const endpoint of classified[modelClass]) {
        if (!includeDeprecated && endpoint.status?.deprecated) continue;
        if (query.requiresTools && !endpointCapabilities(endpoint).tools) continue;
        candidates.push({ endpoint, modelClass });
      }
    }
  }

  let ranked = candidates;
  if (rankedSearch) {
    const exact = candidates.find((candidate) => candidate.endpoint.name === rankedSearch);
    if (exact) {
      ranked = [{ ...exact, score: 0 }];
    } else {
      const threshold = query.threshold ?? DEFAULT_FUZZY_THRESHOLD;
      const searchTokens = tokenize(rankedSearch);
      const tokenMatches = candidates
        .filter((candidate) => {
          const candidateTokens = new Set(searchableValues(candidate.endpoint).flatMap(tokenize));
          return (
            searchTokens.length > 0 && searchTokens.every((token) => candidateTokens.has(token))
          );
        })
        .map((candidate) => ({ ...candidate, score: 0 }));
      if (tokenMatches.length > 0) {
        ranked = tokenMatches.sort(compareRanked);
      } else {
        const fuse = new Fuse(candidates, {
          keys: [
            "endpoint.name",
            "endpoint.displayName",
            "endpoint.family",
            "endpoint.modelServiceName",
            "endpoint.serviceNames",
          ],
          threshold,
          ignoreLocation: true,
          includeScore: true,
          useExtendedSearch: true,
          isCaseSensitive: false,
        });
        const normalizedSearch = tokenize(rankedSearch).join(" ");
        ranked = normalizedSearch
          ? fuse
              .search(normalizedSearch)
              .filter((result) => (result.score ?? 0) <= threshold)
              .map((result) => ({ ...result.item, score: result.score ?? 0 }))
              .sort(compareRanked)
          : [];
      }
    }
  }
  const restored = ranked.map((result) => ({
    ...result,
    endpoint: originalByName.get(result.endpoint.name) ?? result.endpoint,
  }));
  return query.limit === undefined ? restored : restored.slice(0, Math.max(0, query.limit));
}

function matchesModelQuery(endpoint: ServingEndpointSummary, query: ModelQuery): boolean {
  if (query.name !== undefined && endpoint.name !== query.name) return false;
  if (query.task !== undefined && endpoint.task !== query.task) return false;
  if (
    query.reasoningEffort !== undefined &&
    !endpoint.reasoningEfforts?.includes(query.reasoningEffort)
  ) {
    return false;
  }
  if (
    query.dimension !== undefined ||
    query.minDimension !== undefined ||
    query.maxDimension !== undefined
  ) {
    if (endpoint.dimension === undefined) return false;
    if (query.dimension !== undefined && endpoint.dimension !== query.dimension) return false;
    if (query.minDimension !== undefined && endpoint.dimension < query.minDimension) return false;
    if (query.maxDimension !== undefined && endpoint.dimension > query.maxDimension) return false;
  }
  return true;
}

/** Classify chat and embedding endpoints through the TypeScript-owned policy. */
export function classifyEndpointClasses(
  endpoints: readonly ServingEndpointSummary[],
): ReadonlyMap<string, ModelClass> {
  const classified = classifyEndpoints(endpoints);
  const result = new Map<string, ModelClass>();
  for (const modelClass of MODEL_CLASS_ORDER) {
    for (const endpoint of classified[modelClass]) result.set(endpoint.name, modelClass);
  }
  return result;
}

/** Normalize serialized SDK endpoint records without native bindings. */
export function normalizeEndpoints(endpoints: readonly unknown[]): ServingEndpointSummary[] {
  const summaries = endpoints.flatMap((value) => {
    const endpoint = record(value);
    const name = stringUtils.trimToUndefined(endpoint.name);
    if (!name) return [];
    const entities = arrayValue(record(endpoint.config).served_entities).map(record);
    const identities = [
      name,
      ...entities.flatMap((entity) =>
        [
          stringUtils.trimToUndefined(entity.entity_name),
          stringUtils.trimToUndefined(record(entity.foundation_model).name),
          stringUtils.trimToUndefined(record(entity.external_model).name),
        ].filter((identity): identity is string => Boolean(identity)),
      ),
    ];
    const modelServiceName = entities
      .map(
        (entity) =>
          stringUtils.trimToUndefined(record(entity.foundation_model).name) ??
          stringUtils.trimToUndefined(entity.entity_name),
      )
      .find(Boolean);
    const foundationModels = entities.map((entity) => record(entity.foundation_model));
    const family =
      foundationModels
        .map((model) => stringUtils.trimToUndefined(model.model_class))
        .find(Boolean) ?? identities.map(modelFamily).find(Boolean);
    const reasoningEfforts =
      identities.map(modelReasoningEfforts).sort((left, right) => right.length - left.length)[0] ??
      [];
    const profile = entities.map(modelProfile).find(Boolean);
    const capabilitiesRecord = record(endpoint.capabilities);
    const foundationDescription = foundationModels
      .map((model) => stringUtils.trimToUndefined(model.description))
      .find(Boolean);
    const description = stringUtils.trimToUndefined(endpoint.description) ?? foundationDescription;
    const summary: ServingEndpointSummary = {
      name,
      displayName: toModelDisplayName(name, providedDisplayName(endpoint, entities)),
      ...(family ? { family } : {}),
      ...(stringUtils.trimToUndefined(endpoint.task)
        ? { task: stringUtils.trimToUndefined(endpoint.task) }
        : {}),
      ...(stringUtils.trimToUndefined(record(endpoint.state).ready)
        ? { state: stringUtils.trimToUndefined(record(endpoint.state).ready) }
        : {}),
      ...(description ? { description } : {}),
      supportsTools:
        booleanValue(capabilitiesRecord.function_calling) ?? identities.some(supportsToolsByFamily),
      ...(profile ? { profile } : {}),
      serviceNames: Object.assign({}, ...identities.map(modelServiceNames)),
      ...(modelServiceName ? { modelServiceName } : {}),
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
      status: modelStatusFor(...identities),
    };
    return [summary];
  });
  const classes = classifyEndpointClasses(summaries);
  return summaries.map((summary) => {
    const modelClass = classes.get(summary.name);
    return modelClass ? { ...summary, class: modelClass } : summary;
  });
}

function compareRanked(left: RankedModel, right: RankedModel): number {
  const score = Math.round((left.score ?? 0) * 1000) - Math.round((right.score ?? 0) * 1000);
  if (score !== 0) return score;
  const leftOss = isOpenWeightsGpt(left.endpoint.name);
  const rightOss = isOpenWeightsGpt(right.endpoint.name);
  if (leftOss !== rightOss) return leftOss ? 1 : -1;
  const leftVersion = versionTuple(left.endpoint.name);
  const rightVersion = versionTuple(right.endpoint.name);
  for (let index = 0; index < 3; index += 1) {
    const version = rightVersion[index]! - leftVersion[index]!;
    if (version !== 0) return version;
  }
  const variant = modelVariantRank(left.endpoint.name) - modelVariantRank(right.endpoint.name);
  if (variant !== 0) return variant;
  return MODEL_CLASS_ORDER.indexOf(left.modelClass) - MODEL_CLASS_ORDER.indexOf(right.modelClass);
}

function modelVariantRank(name: string): number {
  if (!/(?:^|[-_.])gpt(?:[-_.]|$)/i.test(name)) return 2;
  if (/(?:^|[-_.])sol(?:[-_.]|$)/i.test(name)) return 0;
  if (/(?:^|[-_.])luna(?:[-_.]|$)/i.test(name)) return 1;
  return 2;
}

/**
 * Resolve generic job searches to the capability class that owns the work.
 *
 * A pure intent such as "summarize" ranks that capability directly. Mixed
 * queries remove the intent word but retain the model identity, so "gpt chat"
 * still uses the historical version and variant preference for GPT.
 */
function modelSearchPlan(
  search: string,
): { readonly modelClass: ModelClass; readonly search?: string } | undefined {
  const tokens = tokenize(search).filter((token) => !SEARCH_INTENT_FILLERS.has(token));
  if (tokens.length === 0) return undefined;
  const chat = tokens.some((token) => CHAT_SEARCH_INTENTS.has(token));
  const embedding = tokens.some((token) => EMBEDDING_SEARCH_INTENTS.has(token));
  if (chat === embedding) return undefined;
  const intentWords = chat ? CHAT_SEARCH_INTENTS : EMBEDDING_SEARCH_INTENTS;
  const remaining = tokens.filter((token) => !intentWords.has(token));
  return {
    modelClass: chat ? ModelClass.ChatThinking : ModelClass.Embedding,
    ...(remaining.length > 0 ? { search: remaining.join(" ") } : {}),
  };
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function searchableValues(endpoint: ServingEndpointSummary): string[] {
  return [
    endpoint.name,
    endpoint.displayName,
    endpoint.family,
    endpoint.modelServiceName,
    ...Object.values(endpoint.serviceNames ?? {}),
  ].filter((value): value is string => Boolean(value));
}

function modelProfile(entity: Record<string, unknown>) {
  const source = record(record(entity.foundation_model).ai_gateway_model_profile);
  const quality = finiteNumber(source.quality);
  const speed = finiteNumber(source.speed);
  const cost = finiteNumber(source.cost);
  if (quality === undefined && speed === undefined && cost === undefined) return undefined;
  return {
    ...(quality !== undefined ? { quality } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function providedDisplayName(
  endpoint: Record<string, unknown>,
  entities: readonly Record<string, unknown>[],
): string | undefined {
  for (const tag of arrayValue(endpoint.tags).map(record)) {
    if (!["display_name", "displayName", "name"].includes(String(tag.key))) continue;
    const value = stringUtils.trimToUndefined(tag.value);
    if (value) return value;
  }
  return (
    entities
      .map((entity) => stringUtils.trimToUndefined(record(entity.foundation_model).display_name))
      .find(Boolean) ??
    entities
      .map((entity) => stringUtils.trimToUndefined(record(entity.external_model).name))
      .find(Boolean)
  );
}

function record(value: unknown): Record<string, unknown> {
  return object.isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
