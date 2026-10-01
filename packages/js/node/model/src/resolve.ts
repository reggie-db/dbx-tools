/**
 * Workspace-aware model selection.
 *
 * Given a caller's intent - a search string, a capability {@link ModelClass}
 * ceiling, both, or nothing - the toolkit returns matching endpoints ranked by
 * match quality then class, or collapses to the single best id the workspace
 * actually has, degrading from "best in range" down to the static fallback
 * floor. Selection is chat-only: embedding endpoints surface only when
 * `modelClass` is explicitly {@link ModelClass.Embedding}.
 *
 * Two shapes of selection, each in a pure form (over an endpoint list the
 * caller already holds) and an I/O wrapper (that lists `/serving-endpoints`
 * first): ranking, which returns a match- then class-ordered list, and
 * single-selection, which collapses to one id plus how it was reached and
 * layers the operator-pinned fallback / static-floor safety net on top. A chat
 * `modelClass` acts as a ceiling: that band and the less-capable chat bands
 * below it are eligible (see {@link classesAtOrBelow}), so a `chat-balanced`
 * ask can fall to `chat-fast` but never escalate to `chat-thinking`.
 *
 * @module
 */

import { object } from "@dbx-tools/shared-core";
import {
  model,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

import { rankEndpointsWithRust } from "./_native.ts";
import { FALLBACK_MODEL_IDS, modelsForClass } from "./fallback.ts";
import { endpointSupportsTools } from "./policy.ts";
import {
  listServingEndpoints,
  type ResolvedModel,
  type ResolveModelOptions,
  type WorkspaceClientLike,
} from "./serving.ts";

type ModelClass = model.ModelClass;

/** Preferred live family for an unconfigured general-purpose chat default. */
const DEFAULT_MODEL_FAMILY_SEARCH = "gpt";

/** Caller intent passed to {@link resolveModel}. */
export interface ResolveModelInput {
  /**
   * Explicit model id / loose name (per-request override, agent / plugin
   * default, or env var). When set it wins over `modelClass` and `fallbacks`.
   */
  explicit?: string;
  /**
   * Fuzzy-match an `explicit` name against the live catalogue so loose names
   * like `"claude sonnet"` resolve. Default `true`. When `false` the explicit
   * input is returned verbatim (Databricks surfaces the canonical 404 if it
   * doesn't exist).
   */
  fuzzy?: boolean;
  /** Rust fuzzy-distance threshold forwarded to the search match. */
  threshold?: number;
  /** Require a model that supports a complete function-tool round-trip. */
  requiresTools?: boolean;
  /**
   * Chat capability class to resolve when no `explicit` id is given. The live
   * catalogue is classified by its Foundation Model API scores and the top
   * available model in the class (and the chat bands below it) wins, falling
   * back to the class's small static list.
   */
  modelClass?: ModelClass;
  /**
   * Operator-supplied fallback ids tried *first* in the no-explicit, no-class
   * path (e.g. a regulated workspace pinned to an approved subset), ahead of
   * the auto-classified catalogue.
   */
  fallbacks?: readonly string[];
  /**
   * Refuse the static offline floor when the live catalogue has no match.
   * Use for unpinned defaults that must always name a currently available
   * endpoint.
   */
  liveOnly?: boolean;
}

/** Outcome of {@link resolveModel}: the chosen id plus how it was reached. */
export interface ResolvedModelSelection {
  modelId: string;
  source: "explicit" | "fuzzy-match" | "class" | "fallback";
}

/** Intent + catalogue knobs passed to {@link selectModel}. */
export interface SelectModelInput extends ResolveModelInput {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
  /** Trusted opaque identity of the credential used by the workspace client. */
  cacheIdentity?: string;
}

/** TTL override merged into a {@link ModelQuery} for {@link searchModels}. */
export interface SearchModelsInput extends ModelQuery {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
  /** Trusted opaque identity of the credential used by the workspace client. */
  cacheIdentity?: string;
}

/**
 * Rank the live catalogue against a {@link ModelQuery}, best-first.
 *
 * Rust owns classification, fuzzy scoring, family-version ordering, preferred
 * variants, class ceilings, tool filtering, and result limiting. Node retains
 * the caller's endpoint objects so fields outside the ranking contract remain
 * available unchanged.
 */
export function lookupModels(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
): RankedModel[] {
  return rankEndpointsWithRust(endpoints, query);
}

/**
 * Collapse {@link lookupModels} to a single id: the closest endpoint to `search`
 * in a catalogue snapshot, or the input verbatim when nothing scores within the
 * threshold.
 *
 * The ranked counterpart to {@link resolveModelId}: equal
 * match scores are broken by class and then within-class version, so a loose
 * `"opus"` prefers `opus-5` over `opus-4-7` instead of picking whichever
 * sibling appeared first. Returning the input unmatched (rather
 * than a near neighbour) is deliberate - a deliberate endpoint id is never
 * silently rewritten, and Databricks surfaces a clean 404.
 */
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

/**
 * {@link rankModelId} against a catalogue the caller may be holding stale:
 * match the loaded snapshot, and on a miss reload once with `force` and match
 * again. That way a model deployed after the catalogue was cached still
 * resolves on first use, without a restart and without giving up caching.
 *
 * The catalogue arrives as a loader rather than a client so the caller keeps
 * ownership of *how* it is cached - {@link listServingEndpoints} and its
 * `CacheManager`, a plain process-lifetime field in a CLI, or a test double.
 * Only one reload is attempted: a genuinely unknown name should fail fast
 * rather than re-list on every request.
 *
 * @param load - Returns the catalogue; `force` asks it to bypass its cache.
 */
export async function rankModelIdLive(
  load: (force: boolean) => Promise<readonly ServingEndpointSummary[]>,
  search: string,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  const resolved = rankModelId(await load(false), search, options);
  if (resolved.matched) return resolved;
  return rankModelId(await load(true), search, options);
}

/**
 * Rank a workspace's catalogue in one call: list its `/serving-endpoints`
 * (cached) and run {@link lookupModels} over the result. The list counterpart to
 * {@link selectModel}, for a consumer that wants the full ranked set (a model
 * picker, a CLI) rather than a single id. Catalogue fetches fail loud: network
 * / auth errors propagate so the caller sees the real SDK message.
 *
 * @param host - Workspace host used as the cache key. Pass the value resolved
 *   from `client.config.getHost()`.
 */
export async function searchModels(
  client: WorkspaceClientLike,
  host: string,
  input: SearchModelsInput = {},
): Promise<RankedModel[]> {
  const endpoints = await listServingEndpoints(client, host, {
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.cacheIdentity !== undefined ? { cacheIdentity: input.cacheIdentity } : {}),
  });
  return lookupModels(endpoints, input);
}

/**
 * Resolve a model id for a workspace in one call: list its `/serving-endpoints`
 * (cached) and run {@link resolveModel} over the result. This is the entry
 * point for any consumer that holds a `WorkspaceClient` and just wants a usable
 * model name - a Lakeflow job, a one-off script, or the Mastra plugin alike.
 *
 * Cheap exit: when an `explicit` name is given, `fuzzy` is off, and tool
 * capability is not required, the catalogue is never fetched. Catalogue
 * fetches otherwise fail loud: network / auth errors propagate so the caller
 * sees the real SDK message instead of a silent fallback.
 *
 * @param host - Workspace host used as the cache key. Pass the value resolved
 *   from `client.config.getHost()`.
 */
export async function selectModel(
  client: WorkspaceClientLike,
  host: string,
  input: SelectModelInput = {},
): Promise<ResolvedModelSelection> {
  if (input.explicit !== undefined && input.fuzzy === false && !input.requiresTools) {
    return { modelId: input.explicit, source: "explicit" };
  }
  const endpoints = await listServingEndpoints(client, host, {
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.cacheIdentity !== undefined ? { cacheIdentity: input.cacheIdentity } : {}),
  });
  return resolveModel(endpoints, input);
}

/**
 * Resolve a single model id from the live catalogue and caller intent,
 * delegating the live selection to {@link lookupModels} with `limit: 1`.
 *
 * 1. **Explicit ask**: with `fuzzy` off, returned verbatim; otherwise
 *    fuzzy-ranked within the (optional) class ceiling and the best taken,
 *    falling back to the input verbatim when nothing matches.
 * 2. **No explicit ask**: an operator-pinned `fallback` that exists in the live
 *    catalogue wins first. A class request ranks within that ceiling. A
 *    general request prefers the highest-ranked live GPT, then any ranked live
 *    chat model. The static {@link FALLBACK_MODEL_IDS} floor is used only when
 *    the catalogue yields nothing in range.
 */
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

  // Operator-pinned fallbacks win when present and live (e.g. a regulated
  // workspace restricted to an approved subset).
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

  // Live catalogue yielded nothing in range: walk the static floor.
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

/** Build a {@link ModelQuery} from {@link ResolveModelInput} for the `limit: 1` delegation. */
function buildQuery(input: ResolveModelInput, search: string | undefined): ModelQuery {
  return {
    ...(search !== undefined ? { search } : {}),
    ...(input.modelClass !== undefined ? { modelClass: input.modelClass } : {}),
    ...(input.requiresTools !== undefined ? { requiresTools: input.requiresTools } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    limit: 1,
  };
}

/** Throw when an explicit id is absent or not verified for function tools. */
function assertToolSupport(endpoints: readonly ServingEndpointSummary[], modelId: string): void {
  const endpoint = endpoints.find((candidate) => candidate.name === modelId);
  if (!endpoint || !endpointSupportsTools(endpoint)) {
    throw new Error(`Model "${modelId}" does not support function tools`);
  }
}

/**
 * Find the first id in `candidates` whose endpoint is present in `endpoints`.
 * Returns the top candidate when the workspace has none of them so callers
 * always get a string; an offline workspace then receives a clean 404 from
 * Databricks instead of a malformed config.
 */
function pickFirstAvailable(
  candidates: readonly string[],
  endpoints: readonly ServingEndpointSummary[],
): string {
  const present = new Set(endpoints.map((e) => e.name));
  for (const candidate of candidates) {
    if (present.has(candidate)) return candidate;
  }
  return candidates[0] ?? FALLBACK_MODEL_IDS[0]!;
}
