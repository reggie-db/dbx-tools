/**
 * Reusable generator operations shared by tools and workflow steps.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import type {
  BrandGenerationRequest,
  BrandPackage,
  KpiResearchRequest,
  KpiResearchResult,
  CreateGeneratorPresentationRequest,
  GeneratedDashboard,
  GeneratedGenieSpace,
  GeneratedSchema,
  GeneratorPlan,
  MaterializeGeneratorDataRequest,
  MaterializedGeneratorData,
  PlanGeneratorDataRequest,
  ProvisionGeneratorSchemaRequest,
} from "@dbx-tools/shared-generator";
import type { ResolvedGeneratorConfig } from "./config.ts";
import { createGeneratorDashboard } from "./dashboard.ts";
import { materializeGeneratorData } from "./data.ts";
import { generateBrandPackage } from "./generate.ts";
import { createGeneratorGenieSpace } from "./genie.ts";
import { researchKpis } from "./kpi.ts";
import { provisionGeneratorSchema } from "./namespace.ts";
import { planGeneratorData } from "./plan.ts";
import type { BrandProgressReporter, BrandResearchClient } from "./research.ts";

/** Runtime dependencies captured by one generator plugin instance. */
export interface GeneratorOperationsOptions {
  /** Resolved generator configuration. */
  config: ResolvedGeneratorConfig;
  /** Registered web-search plugin operations. */
  researchClient: BrandResearchClient;
}

/** One behavior owner for every generator tool and workflow step. */
export class GeneratorOperations {
  private readonly config: ResolvedGeneratorConfig;
  private readonly researchClient: BrandResearchClient;

  /** Create operations over one isolated plugin runtime. */
  constructor(options: GeneratorOperationsOptions) {
    this.config = options.config;
    this.researchClient = options.researchClient;
  }

  /** Generate portable brand assets without KPI research or Databricks writes. */
  generateBrand(
    request: BrandGenerationRequest,
    signal?: AbortSignal,
    onProgress?: BrandProgressReporter,
  ): Promise<BrandPackage> {
    return generateBrandPackage(
      request,
      {
        client: this.researchClient,
        ...(this.config.model ? { model: this.config.model } : {}),
        maxSources: this.config.maxSources,
        sourceMaxLength: this.config.sourceMaxLength,
        ...(onProgress ? { onProgress } : {}),
      },
      signal,
    );
  }

  /** Research KPIs independently of any mutation workflow. */
  researchKpis(request: KpiResearchRequest, signal?: AbortSignal): Promise<KpiResearchResult> {
    return researchKpis(
      request,
      {
        client: this.researchClient,
        maxSources: this.config.maxSources,
        sourceMaxLength: this.config.sourceMaxLength,
        ...(this.config.model ? { model: this.config.model } : {}),
      },
      signal,
    );
  }

  /** Build a typed deterministic data plan. */
  planData(request: PlanGeneratorDataRequest, signal?: AbortSignal): Promise<GeneratorPlan> {
    return planGeneratorData(
      {
        ...request,
        ...(this.config.model ? { model: this.config.model } : {}),
      },
      signal,
    );
  }

  /** Provision the active OBO user's deterministic schema. */
  provisionSchema(
    request: ProvisionGeneratorSchemaRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedSchema> {
    return provisionGeneratorSchema(
      {
        catalog: this.requiredCatalog(),
        request: request.request,
      },
      signal,
    );
  }

  /** Materialize generated data and validate its KPI aggregates. */
  materializeData(
    request: MaterializeGeneratorDataRequest,
    signal?: AbortSignal,
  ): Promise<MaterializedGeneratorData> {
    return materializeGeneratorData(
      request.location,
      request.plan,
      this.requiredWarehouseId(),
      signal,
    );
  }

  /** Create and publish a dashboard with automatic companion Genie. */
  createDashboard(
    request: CreateGeneratorPresentationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedDashboard> {
    return createGeneratorDashboard(
      {
        location: request.location,
        plan: request.plan,
        brand: request.brand.brand,
        company: request.request.company,
        purpose: request.request.purpose,
        warehouseId: this.requiredWarehouseId(),
      },
      signal,
    );
  }

  /** Create a standalone Genie space for no-dashboard runs. */
  createGenie(
    request: CreateGeneratorPresentationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedGenieSpace> {
    return createGeneratorGenieSpace(
      {
        location: request.location,
        plan: request.plan,
        company: request.request.company,
        purpose: request.request.purpose,
        warehouseId: this.requiredWarehouseId(),
      },
      signal,
    );
  }

  /** Configured catalog or a deployment-time configuration error. */
  private requiredCatalog(): string {
    if (!this.config.catalog) {
      throw new ConfigurationError("GENERATOR_CATALOG is required for generator mutations");
    }
    return this.config.catalog;
  }

  /** Configured SQL warehouse or a deployment-time configuration error. */
  private requiredWarehouseId(): string {
    if (!this.config.warehouseId) {
      throw new ConfigurationError("DATABRICKS_WAREHOUSE_ID is required for generator mutations");
    }
    return this.config.warehouseId;
  }
}
