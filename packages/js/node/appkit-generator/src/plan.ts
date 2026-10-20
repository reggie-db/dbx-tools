/**
 * Structured demo-data planning from brand and KPI research.
 *
 * @module
 */

import {
  GeneratorPlanSchema,
  type BrandPackage,
  type KpiResearchResult,
  type GeneratorPlan,
  type GeneratorRequest,
} from "@dbx-tools/shared-generator";
import { generateStructured } from "./structured.ts";

/** Inputs for deterministic demo-data planning. */
export interface PlanGeneratorDataInput {
  /** Validated workflow request. */
  request: GeneratorRequest;
  /** Researched brand package. */
  brand: BrandPackage;
  /** Evidence-backed KPI research. */
  kpiResearch: KpiResearchResult;
  /** Optional model preference. */
  model?: string;
}

/** Build a constrained plan that can be compiled without model-authored SQL. */
export async function planGeneratorData(
  input: PlanGeneratorDataInput,
  signal?: AbortSignal,
): Promise<GeneratorPlan> {
  const generated = await generateStructured({
    id: "demo-data-planner",
    instructions: [
      "Plan one denormalized Delta fact table for a realistic business demo.",
      "Use only the supplied generator kinds and KPI aggregations.",
      "Include an id column, a date column, two to six useful categories,",
      "numeric columns needed by every KPI, and a measurable anomaly.",
      "Do not write SQL. Do not invent unsupported generator fields.",
    ].join(" "),
    prompt: JSON.stringify(
      {
        request: input.request,
        brand: input.brand.brand,
        kpis: input.kpiResearch.kpis,
      },
      null,
      2,
    ),
    schema: GeneratorPlanSchema,
    ...(input.model ? { model: input.model } : {}),
    ...(signal ? { signal } : {}),
  });
  return GeneratorPlanSchema.parse({
    ...generated,
    rowCount: input.request.rowCount,
  });
}
