/**
 * AppKit ToolProvider plugin for governed Databricks demo generation.
 *
 * @module
 */

import { defineManifest, toPlugin, type IAppRouter } from "@databricks/appkit";
import { defineTool, type ToolRegistry } from "@databricks/appkit/beta";
import { pluginRegistry, ToolRegistryPlugin } from "@dbx-tools/appkit";
import { mastra } from "@dbx-tools/appkit-mastra";
import { webSearch } from "@dbx-tools/appkit-web-search";
import { errorUtils, log } from "@dbx-tools/shared-core";
import {
  GENERATOR_ROUTES,
  GeneratorClientConfigSchema,
  GeneratorPluginClient,
  BrandGenerationEventSchema,
  BrandGenerationRequestSchema,
  type BrandGenerationEvent,
} from "@dbx-tools/shared-generator/brand";
import { KpiResearchRequestSchema, KpiResearchResultSchema } from "@dbx-tools/shared-generator/kpi";
import {
  CreateGeneratorPresentationRequestSchema,
  GeneratedAssetsSchema,
  GeneratedDashboardSchema,
  GeneratedGenieSpaceSchema,
  GeneratedSchemaSchema,
  GeneratorPlanSchema,
  MaterializeGeneratorDataRequestSchema,
  MaterializedGeneratorDataSchema,
  PlanGeneratorDataRequestSchema,
  ProvisionGeneratorSchemaRequestSchema,
} from "@dbx-tools/shared-generator/workflow";
import {
  resolveGeneratorConfig,
  type GeneratorPluginConfig,
  type ResolvedGeneratorConfig,
} from "./config.ts";
import manifest from "./manifest.json" with { type: "json" };
import { GeneratorOperations } from "./operations.ts";
import type { BrandResearchClient } from "./research.ts";
import { GENERATE_BRAND_TOOL_DESCRIPTION } from "./schema.ts";
import { createGeneratorWorkflow, type GeneratorWorkflow } from "./workflow.ts";

const logger = log.logger("generator");
const WORKFLOW_KEY = "generatorDemoAssets";

/** AppKit plugin exposing reusable generator tools and a hosted Mastra workflow. */
export class GeneratorPlugin extends ToolRegistryPlugin<GeneratorPluginConfig> {
  static manifest = defineManifest<"generator">(manifest);

  private readonly resolved: ResolvedGeneratorConfig = resolveGeneratorConfig(this.config);
  private operations: GeneratorOperations | undefined;
  private workflow: GeneratorWorkflow | undefined;

  /** AppKit mount prefix used by browser clients. */
  private get basePath(): string {
    return `/api/${this.name}`;
  }

  /** Native tools exposed independently of the composed workflow. */
  protected get toolRegistry(): ToolRegistry {
    const operations = this.requireOperations();
    const mutation = { effect: "write" as const, destructive: true, requiresUserContext: true };
    return {
      generate_brand: defineTool({
        description: GENERATE_BRAND_TOOL_DESCRIPTION,
        schema: BrandGenerationRequestSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: (input, signal) =>
          operations.generateBrand(BrandGenerationRequestSchema.parse(input), signal),
      }),
      research_kpis: defineTool({
        description: "Research evidence-backed KPIs for company demo questions.",
        schema: KpiResearchRequestSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: (input, signal) =>
          operations.researchKpis(KpiResearchRequestSchema.parse(input), signal),
      }),
      plan_demo_data: defineTool({
        description: "Build a typed deterministic data plan from brand and KPI research.",
        schema: PlanGeneratorDataRequestSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: (input, signal) =>
          operations.planData(PlanGeneratorDataRequestSchema.parse(input), signal),
      }),
      provision_schema: defineTool({
        description: "Provision and grant the active user's deterministic Unity Catalog schema.",
        schema: ProvisionGeneratorSchemaRequestSchema,
        annotations: mutation,
        autoInheritable: false,
        execute: (input, signal) =>
          operations.provisionSchema(ProvisionGeneratorSchemaRequestSchema.parse(input), signal),
      }),
      materialize_data: defineTool({
        description: "Create generated Delta data and validate every planned KPI.",
        schema: MaterializeGeneratorDataRequestSchema,
        annotations: mutation,
        autoInheritable: false,
        execute: (input, signal) =>
          operations.materializeData(MaterializeGeneratorDataRequestSchema.parse(input), signal),
      }),
      create_dashboard: defineTool({
        description: "Create and publish an AI/BI dashboard with automatic companion Genie.",
        schema: CreateGeneratorPresentationRequestSchema,
        annotations: mutation,
        autoInheritable: false,
        execute: (input, signal) =>
          operations.createDashboard(CreateGeneratorPresentationRequestSchema.parse(input), signal),
      }),
      create_genie_space: defineTool({
        description: "Create a standalone Genie space when no dashboard is requested.",
        schema: CreateGeneratorPresentationRequestSchema,
        annotations: mutation,
        autoInheritable: false,
        execute: (input, signal) =>
          operations.createGenie(CreateGeneratorPresentationRequestSchema.parse(input), signal),
      }),
    };
  }

  /** Capture sibling capabilities and register the workflow before Mastra boots. */
  override async setup(): Promise<void> {
    this.operations = new GeneratorOperations({
      config: this.resolved,
      researchClient: this.researchClient(),
    });
    this.workflow = createGeneratorWorkflow(this.operations);
    pluginRegistry
      .require(this.context, mastra, this)
      .exports()
      .registerWorkflow(WORKFLOW_KEY, this.workflow);
    logger.info("ready", {
      model: this.resolved.model ?? "automatic",
      catalog: this.resolved.catalog ?? "brand-only",
      warehouse: this.resolved.warehouseId ?? "brand-only",
      workflow: WORKFLOW_KEY,
    });
  }

  shutdown(): void {
    return;
  }

  override clientConfig() {
    return GeneratorClientConfigSchema.parse({ basePath: this.basePath });
  }

  /** Stream standalone brand generation to the existing Brand page. */
  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "generateBrand",
      method: "post",
      path: GENERATOR_ROUTES.generateBrand,
      handler: async (req, res) => {
        const parsed = BrandGenerationRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Enter a brand name and an optional HTTPS website." });
          return;
        }
        res.set({
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        let closed = false;
        const controller = new AbortController();
        res.on("close", () => {
          closed = true;
          controller.abort();
        });
        const send = (event: BrandGenerationEvent) => {
          if (closed) return;
          const validated = BrandGenerationEventSchema.parse(event);
          res.write(`event: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`);
        };
        try {
          const generated = await this.asUser(req)
            .requireOperations()
            .generateBrand(parsed.data, controller.signal, send);
          send({ type: "result", package: generated });
        } catch (cause) {
          logger.warn("brand-route-failed", { error: errorUtils.toError(cause) });
          send({
            type: "error",
            message:
              "Brand generation failed. Retry the request; if it fails again, check the server logs.",
          });
        } finally {
          if (!closed) res.end();
        }
      },
    });
  }

  /** Programmatic operations and workflow for trusted application code. */
  override exports() {
    return {
      generateBrand: this.requireOperations().generateBrand.bind(this.requireOperations()),
      researchKpis: this.requireOperations().researchKpis.bind(this.requireOperations()),
      planData: this.requireOperations().planData.bind(this.requireOperations()),
      provisionSchema: this.requireOperations().provisionSchema.bind(this.requireOperations()),
      materializeData: this.requireOperations().materializeData.bind(this.requireOperations()),
      createDashboard: this.requireOperations().createDashboard.bind(this.requireOperations()),
      createGenie: this.requireOperations().createGenie.bind(this.requireOperations()),
      workflow: this.workflow,
      schemas: {
        kpiResearch: KpiResearchResultSchema,
        plan: GeneratorPlanSchema,
        location: GeneratedSchemaSchema,
        materialized: MaterializedGeneratorDataSchema,
        dashboard: GeneratedDashboardSchema,
        genie: GeneratedGenieSpaceSchema,
        assets: GeneratedAssetsSchema,
      },
      client: GeneratorPluginClient,
    };
  }

  /** Resolve the sibling web-search plugin without recreating its policy. */
  private researchClient(): BrandResearchClient {
    const sibling = pluginRegistry.require(this.context, webSearch, this).exports();
    return {
      search: sibling.search,
      fetch: sibling.fetch,
      fetchAssetPage: sibling.fetchAssetPage,
      fetchImage: sibling.fetchImage,
    };
  }

  /** Initialized operations or a clear lifecycle error. */
  private requireOperations(): GeneratorOperations {
    if (!this.operations) throw new Error("Generator plugin setup has not completed");
    return this.operations;
  }
}

/** Register AppKit generator tools and workflow integration. */
export const generator = toPlugin(GeneratorPlugin);
