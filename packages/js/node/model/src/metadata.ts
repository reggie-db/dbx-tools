/**
 * Build-generated Databricks model retirement, capability, and rate-limit metadata.
 *
 * The committed snapshots are refreshed by `bun run model:metadata`. Runtime
 * lookups build their normalized sets and maps once per process and perform no
 * documentation network requests.
 *
 * @module
 */
import * as functionUtils from "@dbx-tools/shared-core/function-utils";
import type { ModelStatus, ServingEndpointSummary } from "@dbx-tools/shared-model/contracts";

import capabilitiesSnapshotJson from "./generated/model-capabilities.json" with { type: "json" };
import rateLimitsSnapshotJson from "./generated/model-rate-limits.json" with { type: "json" };
import retiredModelsSnapshotJson from "./generated/retired-models.json" with { type: "json" };
import {
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
  type ModelCapabilitiesSnapshot,
  type ModelCapabilityCatalogue,
  type ModelRateLimits,
  type ModelRateLimitsSnapshot,
  type RetiredModelsSnapshot,
} from "./_metadata-contract.ts";
import { modelSearchQuery } from "./policy.ts";

export {
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
};
export type {
  ModelCapabilitiesSnapshot,
  ModelCapabilityCatalogue,
  ModelRateLimitCatalogue,
  ModelRateLimits,
  ModelRateLimitsSnapshot,
  RetiredModelsSnapshot,
} from "./_metadata-contract.ts";

const retiredModelsSnapshot = retiredModelsSnapshotJson as RetiredModelsSnapshot;
const capabilitiesSnapshot = capabilitiesSnapshotJson as ModelCapabilitiesSnapshot;
const rateLimitsSnapshot = rateLimitsSnapshotJson as ModelRateLimitsSnapshot;

/** Documented capabilities resolved for one model identity. */
export interface ModelCapabilities {
  readonly responses: boolean;
  readonly imageInput: boolean;
  readonly applyPatch: boolean;
  readonly webSearch: boolean;
}

/** Combined build-generated metadata resolved for one model identity. */
export interface ModelMetadata {
  readonly status: ModelStatus;
  readonly capabilities: ModelCapabilities;
  readonly rateLimits?: ModelRateLimits;
}

interface MetadataIndex {
  readonly retiredNames: readonly string[];
  readonly retiredKeys: ReadonlySet<string>;
  readonly capabilities: {
    readonly [Key in keyof ModelCapabilityCatalogue]: ReadonlySet<string>;
  };
  readonly rateLimits: ReadonlyMap<string, ModelRateLimits>;
}

const metadataIndex = functionUtils.memoize<MetadataIndex>(() => ({
  retiredNames: Object.freeze([...retiredModelsSnapshot.models]),
  retiredKeys: new Set(retiredModelsSnapshot.models.map(retiredModelKey).filter(Boolean)),
  capabilities: {
    responses: new Set(capabilitiesSnapshot.capabilities.responses),
    imageInput: new Set(capabilitiesSnapshot.capabilities.imageInput),
    applyPatch: new Set(capabilitiesSnapshot.capabilities.applyPatch),
    webSearch: new Set(capabilitiesSnapshot.capabilities.webSearch),
  },
  rateLimits: new Map(Object.entries(rateLimitsSnapshot.catalogue.models)),
}));

/** Return the committed retired-model names. The array is cached and immutable. */
export function retiredModelNames(): readonly string[] {
  return metadataIndex().retiredNames;
}

/** Resolve whether any supplied identity is listed in the retirement snapshot. */
export function modelStatusFor(
  ...models: readonly (string | ServingEndpointSummary)[]
): ModelStatus {
  const retired = metadataIndex().retiredKeys;
  const deprecated = models
    .flatMap((model) => modelIdentities(model))
    .some((identity) => {
      const candidate = retiredModelKey(identity);
      for (const key of retired) {
        if (candidate === key || candidate.startsWith(`${key}-`)) return true;
      }
      return false;
    });
  return { deprecated };
}

/** Resolve documented model capabilities from a name or endpoint summary. */
export function modelCapabilitiesFor(model: string | ServingEndpointSummary): ModelCapabilities {
  const capabilities = metadataIndex().capabilities;
  const keys = modelIdentities(model, false).flatMap((identity) => modelKey(identity) ?? []);
  return {
    responses: keys.some((key) => capabilities.responses.has(key)),
    imageInput: keys.some((key) => capabilities.imageInput.has(key)),
    applyPatch: keys.some((key) => capabilities.applyPatch.has(key)),
    webSearch: keys.some((key) => capabilities.webSearch.has(key)),
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

/** Resolve retirement, capability, and rate-limit metadata together. */
export function modelMetadataFor(model: string | ServingEndpointSummary): ModelMetadata {
  const rateLimits = modelRateLimitsFor(model);
  return {
    status: modelStatusFor(model),
    capabilities: modelCapabilitiesFor(model),
    ...(rateLimits ? { rateLimits } : {}),
  };
}

/** Return generation timestamps for the three committed metadata snapshots. */
export function modelMetadataGeneratedAt(): Readonly<{
  retiredModels: number;
  capabilities: number;
  rateLimits: number;
}> {
  return {
    retiredModels: retiredModelsSnapshot.generatedAt,
    capabilities: capabilitiesSnapshot.generatedAt,
    rateLimits: rateLimitsSnapshot.generatedAt,
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

const RETIRED_MODEL_PREFIXES = new Set([
  "ai",
  "anthropic",
  "databricks",
  "dbx",
  "google",
  "meta",
  "openai",
  "system",
]);

function retiredModelKey(value: string): string {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  while (tokens[0] && RETIRED_MODEL_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.join("-");
}
