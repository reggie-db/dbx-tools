/**
 * Browser-safe KPI research contracts.
 *
 * @module
 */

import { z } from "zod";

const nonBlankString = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);

/** One evidence-backed KPI used to shape generated data and presentation. */
export const ResearchedKpiSchema = z
  .object({
    name: identifier.describe("Stable snake_case KPI identifier."),
    label: nonBlankString.describe("Human-readable KPI label."),
    definition: nonBlankString.describe("Business definition supported by cited research."),
    unit: z
      .enum(["number", "currency", "percent", "duration"])
      .describe("Display unit and formatting family."),
    targetDirection: z
      .enum(["higher", "lower", "neutral"])
      .describe("Whether higher or lower values represent improvement."),
    sourceUrls: z
      .array(z.string().url())
      .describe("Research sources supporting the KPI definition."),
  })
  .strict()
  .describe("Evidence-backed KPI selected for generated demo data.");

/** Evidence-backed KPI. */
export type ResearchedKpi = z.infer<typeof ResearchedKpiSchema>;

/** KPI research request independent of any mutation workflow. */
export const KpiResearchRequestSchema = z
  .object({
    company: nonBlankString.max(200).describe("Company or brand being modeled."),
    purpose: nonBlankString.max(200).describe("Purpose of the generated demonstration."),
    queries: z
      .array(nonBlankString.max(500))
      .min(1)
      .max(10)
      .describe("Natural-language questions the generated data should answer."),
  })
  .strict()
  .describe("Request for web-researched KPIs that shape generated demo data.");

/** KPI research request. */
export type KpiResearchRequest = z.infer<typeof KpiResearchRequestSchema>;

/** KPI research result and its source provenance. */
export const KpiResearchResultSchema = z
  .object({
    kpis: z.array(ResearchedKpiSchema).min(1).max(8).describe("Selected KPI definitions."),
    sources: z
      .array(
        z
          .object({
            url: z.string().url().describe("Research source URL."),
            title: nonBlankString.optional().describe("Source title, when available."),
            fetched: z.boolean().describe("Whether page content was read."),
          })
          .strict(),
      )
      .describe("Deduplicated KPI research sources."),
  })
  .strict()
  .describe("Evidence-backed KPI research output.");

/** KPI research result. */
export type KpiResearchResult = z.infer<typeof KpiResearchResultSchema>;
