/**
 * Mastra workflow composing reusable generator operations.
 *
 * @module
 */

import { BrandPackageSchema, type BrandGenerationRequest } from "@dbx-tools/shared-generator/brand";
import { KpiResearchResultSchema } from "@dbx-tools/shared-generator/kpi";
import {
  GeneratedAssetsSchema,
  GeneratedSchemaSchema,
  GeneratorPlanSchema,
  GeneratorRequestSchema,
  MaterializedGeneratorDataSchema,
} from "@dbx-tools/shared-generator/workflow";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { GeneratorOperations } from "./operations.ts";

/** Operation surface consumed by the workflow and implemented by GeneratorOperations. */
export type GeneratorWorkflowOperations = Pick<
  GeneratorOperations,
  | "generateBrand"
  | "researchKpis"
  | "planData"
  | "provisionSchema"
  | "materializeData"
  | "createDashboard"
  | "createGenie"
>;

/** Construction options for workflow hosts and isolated tests. */
export interface GeneratorWorkflowOptions {
  /** Suspend before mutations. Defaults to true. */
  approval?: boolean;
}

const ResearchOutputSchema = z
  .object({
    request: GeneratorRequestSchema,
    brand: BrandPackageSchema,
    kpiResearch: KpiResearchResultSchema,
  })
  .strict();

const PlanOutputSchema = ResearchOutputSchema.extend({
  plan: GeneratorPlanSchema,
}).strict();

const ProvisionOutputSchema = PlanOutputSchema.extend({
  location: GeneratedSchemaSchema,
}).strict();

const MaterializeOutputSchema = ProvisionOutputSchema.extend({
  materialized: MaterializedGeneratorDataSchema,
}).strict();

/** Build one typed workflow over an isolated generator operation owner. */
export function createGeneratorWorkflow(
  operations: GeneratorWorkflowOperations,
  options: GeneratorWorkflowOptions = {},
) {
  const research = createStep({
    id: "research-brand-and-kpis",
    inputSchema: GeneratorRequestSchema,
    outputSchema: ResearchOutputSchema,
    execute: async ({ inputData, abortSignal, writer }) => {
      await writer?.write({ type: "generator-progress", stage: "research", status: "started" });
      const brandRequest: BrandGenerationRequest = {
        name: inputData.company,
        ...(inputData.website ? { website: inputData.website } : {}),
      };
      const [brand, kpiResearch] = await Promise.all([
        operations.generateBrand(brandRequest, abortSignal),
        operations.researchKpis(
          {
            company: inputData.company,
            purpose: inputData.purpose,
            queries: inputData.queries,
          },
          abortSignal,
        ),
      ]);
      return { request: inputData, brand, kpiResearch };
    },
  });

  const plan = createStep({
    id: "plan-demo-data",
    inputSchema: ResearchOutputSchema,
    outputSchema: PlanOutputSchema,
    execute: async ({ inputData, abortSignal, writer }) => {
      await writer?.write({ type: "generator-progress", stage: "plan", status: "started" });
      const generatedPlan = await operations.planData(inputData, abortSignal);
      return { ...inputData, plan: generatedPlan };
    },
  });

  const approval = createStep({
    id: "approve-mutation-plan",
    inputSchema: PlanOutputSchema,
    outputSchema: PlanOutputSchema,
    resumeSchema: z.object({
      approved: z.boolean().describe("Whether the generated mutation plan is approved."),
    }),
    suspendSchema: z.object({
      reason: z.string().describe("Why approval is required."),
      plan: GeneratorPlanSchema,
    }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (options.approval === false) return inputData;
      if (resumeData === undefined) {
        return suspend({
          reason: "Approve schema, data, and presentation creation.",
          plan: inputData.plan,
        });
      }
      if (!resumeData.approved) {
        throw new Error("Generator mutation plan was rejected");
      }
      return inputData;
    },
  });

  const provision = createStep({
    id: "provision-schema",
    inputSchema: PlanOutputSchema,
    outputSchema: ProvisionOutputSchema,
    execute: async ({ inputData, abortSignal, writer }) => {
      await writer?.write({ type: "generator-progress", stage: "schema", status: "started" });
      const location = await operations.provisionSchema(
        {
          request: {
            company: inputData.request.company,
            purpose: inputData.request.purpose,
          },
        },
        abortSignal,
      );
      return { ...inputData, location };
    },
  });

  const materialize = createStep({
    id: "materialize-and-validate-data",
    inputSchema: ProvisionOutputSchema,
    outputSchema: MaterializeOutputSchema,
    execute: async ({ inputData, abortSignal, writer }) => {
      await writer?.write({ type: "generator-progress", stage: "data", status: "started" });
      const materialized = await operations.materializeData(
        {
          location: inputData.location,
          plan: inputData.plan,
        },
        abortSignal,
      );
      return { ...inputData, materialized };
    },
  });

  const presentation = createStep({
    id: "create-presentation",
    inputSchema: MaterializeOutputSchema,
    outputSchema: GeneratedAssetsSchema,
    execute: async ({ inputData, abortSignal, writer }) => {
      await writer?.write({
        type: "generator-progress",
        stage: "presentation",
        status: "started",
      });
      const presentationInput = {
        request: {
          company: inputData.request.company,
          purpose: inputData.request.purpose,
        },
        location: inputData.location,
        plan: inputData.plan,
        brand: inputData.brand,
      };
      if (inputData.request.presentation === "dashboard") {
        const dashboard = await operations.createDashboard(presentationInput, abortSignal);
        return GeneratedAssetsSchema.parse({
          request: inputData.request,
          schema: inputData.location,
          tables: inputData.materialized.tables,
          brand: inputData.brand,
          kpiResearch: inputData.kpiResearch,
          plan: inputData.plan,
          dashboard,
        });
      }
      const genie = await operations.createGenie(presentationInput, abortSignal);
      return GeneratedAssetsSchema.parse({
        request: inputData.request,
        schema: inputData.location,
        tables: inputData.materialized.tables,
        brand: inputData.brand,
        kpiResearch: inputData.kpiResearch,
        plan: inputData.plan,
        genie,
      });
    },
  });

  return createWorkflow({
    id: "generator-demo-assets",
    inputSchema: GeneratorRequestSchema,
    outputSchema: GeneratedAssetsSchema,
    options: { autoRestartActiveRuns: false },
  })
    .then(research)
    .then(plan)
    .then(approval)
    .then(provision)
    .then(materialize)
    .then(presentation)
    .commit();
}

/** Generator workflow type. */
export type GeneratorWorkflow = ReturnType<typeof createGeneratorWorkflow>;
