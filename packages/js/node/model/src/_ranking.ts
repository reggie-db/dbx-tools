import {
  ModelClass as ModelClassValues,
  type ModelClass as ModelClassType,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";
import { toModelDisplayName } from "@dbx-tools/shared-model/display";
import Fuse from "fuse.js";

import { classesAtOrBelow, CHAT_CLASS_ORDER, MODEL_CLASS_ORDER } from "./classes.ts";
import {
  classifyEndpoints,
  endpointCapabilities,
  supportsToolsByFamily,
  versionTuple,
} from "./classify.ts";
import { modelStatusFor } from "./metadata.ts";
import { modelFamily, modelReasoningEfforts, modelServiceNames } from "./policy.ts";

type ModelClass = ModelClassType;
const ModelClass = ModelClassValues;

const DEFAULT_FUZZY_THRESHOLD = 0.4;
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
  const originalByName = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
  const normalized = endpoints.map((endpoint) => ({
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
  const requestedClass = options.modelClass ?? query.modelClass;
  const eligible = requestedClass ? classesAtOrBelow(requestedClass) : CHAT_CLASS_ORDER;
  const candidates: RankedModel[] = [];
  for (const modelClass of eligible) {
    for (const endpoint of classified[modelClass]) {
      if (!options.includeDeprecated && endpoint.status?.deprecated) continue;
      if (query.requiresTools && !endpointCapabilities(endpoint).tools) continue;
      candidates.push({ endpoint, modelClass });
    }
  }

  const search = query.search?.trim();
  let ranked = candidates;
  if (search) {
    const exact = candidates.find((candidate) => candidate.endpoint.name === search);
    if (exact) {
      ranked = [{ ...exact, score: 0 }];
    } else {
      const threshold = query.threshold ?? DEFAULT_FUZZY_THRESHOLD;
      const searchTokens = tokenize(search);
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
        const normalizedSearch = tokenize(search).join(" ");
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
    const name = stringValue(endpoint.name);
    if (!name) return [];
    const entities = arrayValue(record(endpoint.config).served_entities).map(record);
    const identities = [
      name,
      ...entities.flatMap((entity) =>
        [
          stringValue(entity.entity_name),
          stringValue(record(entity.foundation_model).name),
          stringValue(record(entity.external_model).name),
        ].filter((identity): identity is string => Boolean(identity)),
      ),
    ];
    const modelServiceName = entities
      .map(
        (entity) =>
          stringValue(record(entity.foundation_model).name) ?? stringValue(entity.entity_name),
      )
      .find(Boolean);
    const family = identities.map(modelFamily).find(Boolean);
    const reasoningEfforts =
      identities.map(modelReasoningEfforts).sort((left, right) => right.length - left.length)[0] ??
      [];
    const profile = entities.map(modelProfile).find(Boolean);
    const summary: ServingEndpointSummary = {
      name,
      displayName: toModelDisplayName(name, providedDisplayName(endpoint, entities)),
      ...(family ? { family } : {}),
      ...(stringValue(endpoint.task) ? { task: stringValue(endpoint.task) } : {}),
      ...(stringValue(record(endpoint.state).ready)
        ? { state: stringValue(record(endpoint.state).ready) }
        : {}),
      ...(stringValue(endpoint.description)
        ? { description: stringValue(endpoint.description) }
        : {}),
      supportsTools: identities.some(supportsToolsByFamily),
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
    const value = stringValue(tag.value);
    if (value) return value;
  }
  return entities.map((entity) => stringValue(record(entity.external_model).name)).find(Boolean);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
