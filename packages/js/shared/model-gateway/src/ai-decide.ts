/**
 * Browser-safe contracts for the Databricks AI Functions model router.
 *
 * @module
 */

import { ModelClassSchema, ModelSourceSchema } from "@dbx-tools/shared-model";
import { z } from "zod";

/** Canonical virtual model id that selects a model through `ai_decide`. */
export const AI_DECIDE_MODEL_ID = "ai-decide";

/** Concrete endpoint selected by the ai_decide virtual model. */
export const AI_DECIDE_SELECTED_MODEL_HEADER = "x-dbx-tools-ai-decide-model";

/** Optimization strategy applied by the ai_decide virtual model. */
export const AI_DECIDE_STRATEGY_HEADER = "x-dbx-tools-ai-decide-strategy";

/** Decision confidence returned by ai_decide when available. */
export const AI_DECIDE_CONFIDENCE_HEADER = "x-dbx-tools-ai-decide-confidence";

export const AiDecideStrategySchema = z
  .enum(["balanced", "quality", "cost", "latency"])
  .describe("Primary objective supplied to the Databricks AI Functions model decision.");

export type AiDecideStrategy = z.infer<typeof AiDecideStrategySchema>;

export const AiDecideModelFiltersSchema = z
  .object({
    modelClass: ModelClassSchema.optional().describe(
      "Maximum capability class retained before the AI decision.",
    ),
    modelSource: ModelSourceSchema.default("foundation").describe(
      "API-derived endpoint source retained before the AI decision.",
    ),
    requiresTools: z
      .boolean()
      .optional()
      .describe("When true, retain only endpoints that support function tools."),
    requiresStructuredOutput: z
      .boolean()
      .optional()
      .describe("When true, retain only endpoints with structured-output support."),
    families: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe("Optional model-family allowlist."),
    maxCandidates: z
      .number()
      .int()
      .min(2)
      .max(50)
      .default(50)
      .describe("Maximum ranked candidates sent to ai_decide."),
  })
  .strict()
  .describe("Deterministic filters applied before the ai_decide model choice.");

export type AiDecideModelFilters = z.input<typeof AiDecideModelFiltersSchema>;
export type ResolvedAiDecideModelFilters = z.output<typeof AiDecideModelFiltersSchema>;

export const AiDecideObservationSchema = z
  .object({
    selectedModel: z.string().trim().min(1).describe("Concrete serving endpoint selected."),
    strategy: AiDecideStrategySchema,
    confidence: z.number().min(0).max(1).optional(),
    probabilities: z
      .record(z.string(), z.number().min(0).max(1))
      .optional()
      .describe("Candidate probabilities keyed by concrete serving endpoint."),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .describe("Observable result of one Databricks ai_decide model selection.");

export type AiDecideObservation = z.infer<typeof AiDecideObservationSchema>;

/** Match the canonical ai_decide id with an optional dbx/databricks namespace. */
export function isAiDecideModelId(value: string | undefined): boolean {
  return (
    value
      ?.trim()
      .replace(/^(?:dbx|databricks)\//i, "")
      .toLowerCase() === AI_DECIDE_MODEL_ID
  );
}
