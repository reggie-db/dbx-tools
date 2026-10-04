/**
 * Runtime-independent model ranking and selection.
 *
 * @module
 */
import * as object from "@dbx-tools/shared-core/object";
import type {
  ModelClass,
  ModelQuery,
  RankedModel,
  ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";

import { rankEndpoints } from "./_ranking.ts";
import { FALLBACK_MODEL_IDS, modelsForClass } from "./fallback.ts";
import type { ResolvedModel, ResolveModelOptions } from "./model-catalog.ts";
import { endpointSupportsTools } from "./policy.ts";

const DEFAULT_MODEL_FAMILY_SEARCH = "gpt";

/** Caller intent passed to {@link resolveModel}. */
export interface ResolveModelInput {
  explicit?: string;
  fuzzy?: boolean;
  threshold?: number;
  requiresTools?: boolean;
  modelClass?: ModelClass;
  fallbacks?: readonly string[];
  liveOnly?: boolean;
}

/** Outcome of {@link resolveModel}: the chosen id plus how it was reached. */
export interface ResolvedModelSelection {
  modelId: string;
  source: "explicit" | "fuzzy-match" | "class" | "fallback";
}

/** Rank a catalogue against a model query, best-first. */
export function lookupModels(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
): RankedModel[] {
  return rankEndpoints(endpoints, query);
}

/** Resolve the closest model id in one catalogue snapshot. */
export function rankModelId(
  endpoints: readonly ServingEndpointSummary[],
  search: string,
  options: ResolveModelOptions = {},
): ResolvedModel {
  const [top] = lookupModels(endpoints, {
    search,
    limit: 1,
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(options.requiresTools !== undefined ? { requiresTools: options.requiresTools } : {}),
  });
  if (!top) return { modelId: search, matched: false };
  return { modelId: top.endpoint.name, matched: true, score: top.score };
}

/** Resolve a single model id from a catalogue and caller intent. */
export function resolveModel(
  endpoints: readonly ServingEndpointSummary[],
  input: ResolveModelInput = {},
): ResolvedModelSelection {
  if (input.explicit !== undefined) {
    if (input.fuzzy === false) {
      if (input.requiresTools) assertToolSupport(endpoints, input.explicit);
      return { modelId: input.explicit, source: "explicit" };
    }
    const [top] = lookupModels(endpoints, buildQuery(input, input.explicit));
    if (input.requiresTools && !top) {
      throw new Error(`No tool-capable model matches "${input.explicit}"`);
    }
    return { modelId: top?.endpoint.name ?? input.explicit, source: "fuzzy-match" };
  }

  if (input.modelClass === undefined && input.fallbacks && input.fallbacks.length > 0) {
    const present = new Set(
      endpoints
        .filter((endpoint) => !input.requiresTools || endpointSupportsTools(endpoint))
        .map((endpoint) => endpoint.name),
    );
    const pinned = input.fallbacks.find((id) => present.has(id));
    if (pinned) return { modelId: pinned, source: "fallback" };
  }

  const source = input.modelClass !== undefined ? "class" : "fallback";
  if (input.modelClass === undefined) {
    const [preferred] = lookupModels(endpoints, buildQuery(input, DEFAULT_MODEL_FAMILY_SEARCH));
    if (preferred) return { modelId: preferred.endpoint.name, source };
  }
  const [top] = lookupModels(endpoints, buildQuery(input, undefined));
  if (top) return { modelId: top.endpoint.name, source };

  if (input.liveOnly) {
    throw new Error("No matching live Model Serving endpoint is available");
  }

  const floorSource =
    input.modelClass !== undefined ? modelsForClass(input.modelClass) : (input.fallbacks ?? []);
  const floor = object.sequence(floorSource).concat(FALLBACK_MODEL_IDS).distinct().toArray();
  if (input.requiresTools) {
    const available = new Set(
      endpoints.filter(endpointSupportsTools).map((endpoint) => endpoint.name),
    );
    const selected = floor.find((id) => available.has(id));
    if (!selected) throw new Error("No tool-capable model is available");
    return { modelId: selected, source };
  }
  return { modelId: pickFirstAvailable(floor, endpoints), source };
}

function buildQuery(input: ResolveModelInput, search: string | undefined): ModelQuery {
  return {
    ...(search !== undefined ? { search } : {}),
    ...(input.modelClass !== undefined ? { modelClass: input.modelClass } : {}),
    ...(input.requiresTools !== undefined ? { requiresTools: input.requiresTools } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    limit: 1,
  };
}

function assertToolSupport(endpoints: readonly ServingEndpointSummary[], modelId: string): void {
  const endpoint = endpoints.find((candidate) => candidate.name === modelId);
  if (!endpoint || !endpointSupportsTools(endpoint)) {
    throw new Error(`Model "${modelId}" does not support function tools`);
  }
}

function pickFirstAvailable(
  candidates: readonly string[],
  endpoints: readonly ServingEndpointSummary[],
): string {
  const present = new Set(endpoints.map((endpoint) => endpoint.name));
  for (const candidate of candidates) {
    if (present.has(candidate)) return candidate;
  }
  return candidates[0] ?? FALLBACK_MODEL_IDS[0]!;
}
