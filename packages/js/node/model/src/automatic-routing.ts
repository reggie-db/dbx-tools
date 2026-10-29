/**
 * Pure automatic model-routing policy over normalized catalogue snapshots.
 *
 * @module
 */

import {
  AutomaticRouteDecisionSchema,
  ModelClass,
  type AutomaticRouteDecision,
  type AutomaticRouteRequest,
  type AutomaticRouteTier,
  type ModelClass as ModelClassType,
  type RankedModel,
  type ReasoningEffort,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

import { rankEndpoints } from "./_ranking.ts";
import { classifyEndpoints } from "./classify.ts";
import { isOpenWeightsModel } from "./policy.ts";
import type { ModelSelectionPolicyOptions } from "./selection.ts";

const REASONING_ORDER: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const TIER_CLASS: Readonly<Record<AutomaticRouteTier, ModelClassType>> = {
  fast: ModelClass.ChatFast,
  balanced: ModelClass.ChatBalanced,
  thinking: ModelClass.ChatThinking,
};

/** Options controlling pure automatic candidate resolution. */
export interface ResolveAutomaticModelOptions extends ModelSelectionPolicyOptions {
  /** Exact caller-requested reasoning effort that candidates must accept. */
  readonly explicitReasoningEffort?: ReasoningEffort;
  /** Prefer lower-cost profiles, then recognized open-weight models, within the chosen tier. */
  readonly preferCostEfficientModels?: boolean;
}

/** Pure concrete-model result for one automatic decision. */
export interface ResolvedAutomaticModel {
  readonly endpoint: ServingEndpointSummary;
  readonly modelClass: ModelClassType;
  readonly tier: AutomaticRouteTier;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Return the model class represented by an automatic route tier. */
export function automaticTierModelClass(tier: AutomaticRouteTier): ModelClassType {
  return TIER_CLASS[tier];
}

/** Return the automatic tier represented by one concrete chat model class. */
export function automaticTierForModelClass(modelClass: ModelClassType): AutomaticRouteTier {
  if (modelClass === ModelClass.ChatThinking) return "thinking";
  if (modelClass === ModelClass.ChatFast) return "fast";
  return "balanced";
}

/**
 * Produce the deterministic compatibility fallback used when System One is
 * unavailable or its decision is below the configured confidence floor.
 */
export function fallbackAutomaticRouteDecision(
  request: Pick<AutomaticRouteRequest, "eligibleTiers">,
): AutomaticRouteDecision {
  const tier = request.eligibleTiers.includes("balanced")
    ? "balanced"
    : request.eligibleTiers.includes("thinking")
      ? "thinking"
      : "fast";
  return AutomaticRouteDecisionSchema.parse({
    tier,
    reasoningEffort: automaticReasoningForTier(tier),
    confidence: 0,
    reasonCode: "ambiguous",
  });
}

/** Produce a deterministic decision when hard filtering leaves one tier. */
export function automaticDecisionForOnlyTier(tier: AutomaticRouteTier): AutomaticRouteDecision {
  return AutomaticRouteDecisionSchema.parse({
    tier,
    reasoningEffort: automaticReasoningForTier(tier),
    confidence: 1,
    reasonCode: "ambiguous",
  });
}

/** Produce a deterministic decision from an explicit caller reasoning budget. */
export function automaticDecisionForReasoning(
  effort: ReasoningEffort,
  eligibleTiers: readonly AutomaticRouteTier[],
): AutomaticRouteDecision {
  const requestedTier =
    effort === "high" || effort === "xhigh" || effort === "max"
      ? "thinking"
      : effort === "none" || effort === "minimal"
        ? "fast"
        : "balanced";
  const tier = eligibleTiers.includes(requestedTier)
    ? requestedTier
    : fallbackAutomaticRouteDecision({ eligibleTiers: [...eligibleTiers] }).tier;
  return AutomaticRouteDecisionSchema.parse({
    tier,
    reasoningEffort: effort,
    confidence: 1,
    reasonCode: "ambiguous",
  });
}

/** Resolve one validated automatic decision against compatible live endpoints. */
export function resolveAutomaticModel(
  endpoints: readonly ServingEndpointSummary[],
  decision: AutomaticRouteDecision,
  options: ResolveAutomaticModelOptions = {},
): ResolvedAutomaticModel {
  const classes = uniqueClasses([
    automaticTierModelClass(decision.tier),
    ModelClass.ChatBalanced,
    ModelClass.ChatThinking,
    ModelClass.ChatFast,
  ]);
  const classified = classifyEndpoints(endpoints);
  for (const modelClass of classes) {
    const declared = endpoints.filter((endpoint) => endpoint.class === modelClass);
    const candidates = declared.length > 0 ? declared : classified[modelClass];
    const ranked = preferAutomaticCandidates(
      rankEndpoints(
        candidates,
        {
          ...(options.explicitReasoningEffort
            ? { reasoningEffort: options.explicitReasoningEffort }
            : {}),
        },
        { modelClass, preferSystemModels: options.preferSystemModels },
      ),
      options,
    )[0];
    if (!ranked) continue;
    const reasoningEffort = options.explicitReasoningEffort
      ? options.explicitReasoningEffort
      : nearestReasoningEffort(decision.reasoningEffort, ranked.endpoint.reasoningEfforts ?? []);
    return {
      endpoint: ranked.endpoint,
      modelClass: ranked.modelClass,
      tier: automaticTierForModelClass(ranked.modelClass),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  throw new Error("No compatible live model is available for automatic routing");
}

function preferAutomaticCandidates(
  candidates: readonly RankedModel[],
  options: ResolveAutomaticModelOptions,
): RankedModel[] {
  if (!options.preferCostEfficientModels) return [...candidates];
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      if (options.preferSystemModels) {
        const leftSystem = isSystemModel(left.candidate.endpoint);
        const rightSystem = isSystemModel(right.candidate.endpoint);
        if (leftSystem !== rightSystem) return leftSystem ? -1 : 1;
      }
      const leftCost = left.candidate.endpoint.profile?.cost;
      const rightCost = right.candidate.endpoint.profile?.cost;
      if (Number.isFinite(leftCost) && Number.isFinite(rightCost) && leftCost !== rightCost) {
        return leftCost! - rightCost!;
      }
      const leftOpen = isOpenWeightsModel(left.candidate.endpoint.name);
      const rightOpen = isOpenWeightsModel(right.candidate.endpoint.name);
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function isSystemModel(endpoint: ServingEndpointSummary): boolean {
  return endpoint.name.toLowerCase().startsWith("system.ai.");
}

/** Map a generic reasoning target onto one candidate's supported effort ladder. */
export function nearestReasoningEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;
  const requestedIndex = REASONING_ORDER.indexOf(requested);
  return [...supported].sort((left, right) => {
    const leftIndex = REASONING_ORDER.indexOf(left);
    const rightIndex = REASONING_ORDER.indexOf(right);
    const distance = Math.abs(leftIndex - requestedIndex) - Math.abs(rightIndex - requestedIndex);
    return distance !== 0 ? distance : rightIndex - leftIndex;
  })[0];
}

function uniqueClasses(values: readonly ModelClassType[]): ModelClassType[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function automaticReasoningForTier(tier: AutomaticRouteTier): ReasoningEffort {
  if (tier === "thinking") return "high";
  if (tier === "fast") return "minimal";
  return "medium";
}
