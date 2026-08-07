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
  classify,
  model,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

import { CHAT_CLASS_ORDER, classesAtOrBelow, MODEL_CLASS_ORDER } from "./classes.ts";
import { FALLBACK_MODEL_IDS, modelsForClass } from "./fallback.ts";
import {
  listServingEndpoints,
  searchServingEndpoints,
  type ResolvedModel,
  type ResolveModelOptions,
  type WorkspaceClientLike,
} from "./serving.ts";

type ModelClass = model.ModelClass;

const VERSIONED_FAMILY_SEARCHES = new Set([
  "claude",
  "gemini",
  "gemma",
  "glm",
  "gpt",
  "llama",
  "qwen",
]);

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
  /** Fuse.js threshold forwarded to the fuzzy `search` match ({@link searchServingEndpoints}). */
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
}

/** TTL override merged into a {@link ModelQuery} for {@link searchModels}. */
export interface SearchModelsInput extends ModelQuery {
  /** TTL override for the cached `/serving-endpoints` listing, in ms. */
  ttlMs?: number;
}

/**
 * Round a Fuse score to the display precision so version siblings that match a
 * token identically (e.g. `opus-4-7` vs `opus-4-8` for the query `"opus"`) tie
 * on match and let the class / within-class rank decide - which is what
 * surfaces the newer, higher-quality sibling.
 */
function matchBucket(score: number | undefined): number {
  return Math.round((score ?? 0) * 1000);
}

/**
 * Rank the live catalogue against a {@link ModelQuery}, best-first.
 *
 * Candidates are the classified endpoints in the eligible classes:
 * {@link classesAtOrBelow} the requested `modelClass`, or - when none is given
 * - the chat bands only ({@link CHAT_CLASS_ORDER}), so a general ask never
 * surfaces an embedding endpoint. Each class bucket is already best-first from
 * {@link classify.classifyEndpoints}. Ranking is **match then class**:
 *
 * 1. With a `search`, only endpoints matching it survive, ordered by match
 *    distance (bucketed via {@link matchBucket} so near-identical scores tie),
 *    then by class (more capable first), then by the stable within-class rank.
 * 2. Without a `search`, the class-then-rank candidate order stands.
 *
 * A `limit` truncates the result. Returns `[]` when nothing is eligible or
 * matches - callers layer their own fallback.
 */
export function rankModels(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
): RankedModel[] {
  const classified = classify.classifyEndpoints(endpoints);
  const eligible =
    query.modelClass !== undefined ? classesAtOrBelow(query.modelClass) : CHAT_CLASS_ORDER;

  // Flatten eligible classes in capability order, carrying each endpoint's
  // class; bucket order is already best-first.
  const candidates: RankedModel[] = [];
  for (const modelClass of eligible) {
    for (const endpoint of classified[modelClass]) {
      if (query.requiresTools && !classify.endpointCapabilities(endpoint).tools) continue;
      candidates.push({ endpoint, modelClass });
    }
  }

  const search = query.search?.trim();
  let ranked: RankedModel[];
  if (search) {
    const gptFamilySearch = search.toLowerCase() === "gpt";
    const versionedFamilySearch = VERSIONED_FAMILY_SEARCHES.has(search.toLowerCase());
    const scores = new Map<string, number>();
    for (const match of searchServingEndpoints(
      search,
      candidates.map((c) => c.endpoint),
      query.threshold !== undefined ? { threshold: query.threshold } : {},
    )) {
      scores.set(match.endpoint.name, match.score);
    }
    // `Array.prototype.sort` is stable, so endpoints equal on match and class
    // keep their best-first within-class order.
    ranked = candidates
      .filter((c) => scores.has(c.endpoint.name))
      .filter(
        (c) => !gptFamilySearch || !/(?:^|[-_.])gpt[-_.]?oss(?:[-_.]|$)/i.test(c.endpoint.name),
      )
      .map((c) => ({ ...c, score: scores.get(c.endpoint.name) }))
      .sort((a, b) => {
        const byMatch = matchBucket(a.score) - matchBucket(b.score);
        if (byMatch !== 0) return byMatch;
        if (versionedFamilySearch) {
          const aVersion = classify.versionTuple(a.endpoint.name);
          const bVersion = classify.versionTuple(b.endpoint.name);
          for (let index = 0; index < 3; index++) {
            const byVersion = (bVersion[index] ?? 0) - (aVersion[index] ?? 0);
            if (byVersion !== 0) return byVersion;
          }
        }
        return MODEL_CLASS_ORDER.indexOf(a.modelClass) - MODEL_CLASS_ORDER.indexOf(b.modelClass);
      });
  } else {
    ranked = candidates;
  }

  return query.limit !== undefined ? ranked.slice(0, Math.max(0, query.limit)) : ranked;
}

/**
 * Collapse {@link rankModels} to a single id: the closest endpoint to `search`
 * in a catalogue snapshot, or the input verbatim when nothing scores within the
 * threshold.
 *
 * The rank-based counterpart to the Fuse-only {@link resolveModelId}: equal
 * match scores are broken by class and then within-class version, so a loose
 * `"opus"` prefers `opus-5` over `opus-4-7` instead of picking whichever
 * sibling Fuse happened to order first. Returning the input unmatched (rather
 * than a near neighbour) is deliberate - a deliberate endpoint id is never
 * silently rewritten, and Databricks surfaces a clean 404.
 */
export function rankModelId(
  endpoints: readonly ServingEndpointSummary[],
  search: string,
  options: ResolveModelOptions = {},
): ResolvedModel {
  const [top] = rankModels(endpoints, {
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
 * (cached) and run {@link rankModels} over the result. The list counterpart to
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
  const endpoints = await listServingEndpoints(
    client,
    host,
    input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {},
  );
  return rankModels(endpoints, input);
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
  });
  return resolveModel(endpoints, input);
}

/**
 * Resolve a single model id from the live catalogue and caller intent,
 * delegating the live selection to {@link rankModels} with `limit: 1`.
 *
 * 1. **Explicit ask**: with `fuzzy` off, returned verbatim; otherwise
 *    fuzzy-ranked within the (optional) class ceiling and the best taken,
 *    falling back to the input verbatim when nothing matches.
 * 2. **No explicit ask**: an operator-pinned `fallback` that exists in the live
 *    catalogue wins first; then the ranked live catalogue (class ceiling
 *    applied); then the static {@link FALLBACK_MODEL_IDS} floor when the
 *    catalogue yields nothing in range.
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
    const [top] = rankModels(endpoints, buildQuery(input, input.explicit));
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
        .filter((endpoint) => !input.requiresTools || classify.endpointCapabilities(endpoint).tools)
        .map((endpoint) => endpoint.name),
    );
    const pinned = input.fallbacks.find((id) => present.has(id));
    if (pinned) return { modelId: pinned, source: "fallback" };
  }

  const source = input.modelClass !== undefined ? "class" : "fallback";
  const [top] = rankModels(endpoints, buildQuery(input, undefined));
  if (top) return { modelId: top.endpoint.name, source };

  // Live catalogue yielded nothing in range: walk the static floor.
  const floorSource =
    input.modelClass !== undefined ? modelsForClass(input.modelClass) : (input.fallbacks ?? []);
  const floor = object.sequence(floorSource).concat(FALLBACK_MODEL_IDS).distinct().toArray();
  if (input.requiresTools) {
    const available = new Set(
      endpoints
        .filter((endpoint) => classify.endpointCapabilities(endpoint).tools)
        .map((endpoint) => endpoint.name),
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
  if (!endpoint || !classify.endpointCapabilities(endpoint).tools) {
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
