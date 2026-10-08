/**
 * Request-scoped Databricks model discovery for the AppKit gateway.
 *
 * @module
 */

import { getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import {
  metadata,
  modelCatalog,
  policy,
  resolve as modelResolve,
  type ListServingEndpointsOptions,
} from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";
import {
  ModelClass,
  type ResolveModelInput,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";
import type {
  ModelCapabilities,
  ModelCapabilityOverride,
  ModelTarget,
} from "@dbx-tools/shared-model-gateway";

const DEFAULT_CACHE_TTL_MS = 60_000;
const logger = log.logger("appkit/model-gateway/registry");

/** Resolution controls passed through to the model policy owner. */
export type ModelRegistryResolveOptions = Pick<ResolveModelInput, "modelClass" | "requiresTools">;

/** Dynamic model catalogue used by request routing and model-list responses. */
export interface ModelRegistry {
  list(): Promise<ModelTarget[]>;
  search(query: string): Promise<ModelTarget[]>;
  resolve(model?: string, options?: ModelRegistryResolveOptions): Promise<ModelTarget | undefined>;
  refresh(): Promise<void>;
}

/** Configuration for {@link DatabricksModelRegistry}. */
export interface ModelRegistryOptions {
  readonly ttlMs?: number;
  readonly overrides?: readonly ModelCapabilityOverride[];
  /** Discover models with this client instead of the AppKit execution context. */
  readonly client?: WorkspaceClient;
}

interface RegistryContext {
  readonly client: WorkspaceClient;
  readonly host: string;
  readonly identity?: string;
}

/** Model registry backed by the active AppKit execution context. */
export class DatabricksModelRegistry implements ModelRegistry {
  private readonly ttlMs: number;
  private readonly overrides: readonly ModelCapabilityOverride[];
  private readonly client: WorkspaceClient | undefined;

  constructor(options: ModelRegistryOptions = {}) {
    this.ttlMs = positiveTtl(options.ttlMs);
    this.overrides = options.overrides ?? [];
    this.client = options.client;
  }

  async list(): Promise<ModelTarget[]> {
    const context = await this.context();
    logger.debug("loading catalogue", { host: context.host, ttlMs: this.ttlMs });
    const endpoints = await modelCatalog.listServingEndpoints(
      context.client,
      context.host,
      catalogueOptions(context, this.ttlMs),
    );
    const targets = endpoints.map((endpoint) => this.target(endpoint));
    logger.debug("loaded catalogue", {
      endpointCount: endpoints.length,
      host: context.host,
      targetCount: targets.length,
    });
    return targets;
  }

  async resolve(
    model: string | undefined,
    options: ModelRegistryResolveOptions = {},
  ): Promise<ModelTarget | undefined> {
    const requested = model === undefined ? undefined : unqualifiedModel(model);
    const targets = await this.list();
    const exact =
      requested === undefined
        ? undefined
        : targets.find((target) =>
            target.aliases.some(
              (alias) => alias.localeCompare(requested, undefined, { sensitivity: "accent" }) === 0,
            ),
          );
    if (exact && matchesResolveOptions(exact, options)) {
      logger.debug("resolved exact model", { requested, resolved: exact.id });
      return exact;
    }

    const endpoints = targets
      .map((target) => target.endpoint)
      .filter((endpoint): endpoint is ServingEndpointSummary => endpoint !== undefined);
    const resolved = modelResolve.resolveModel(endpoints, {
      ...(requested !== undefined ? { explicit: requested } : {}),
      ...options,
    });
    const target = targets.find((candidate) => candidate.id === resolved.modelId);
    logger.debug("resolved fuzzy model", {
      requested,
      resolved: target?.id,
      source: resolved.source,
    });
    return target;
  }

  async search(query: string): Promise<ModelTarget[]> {
    const targets = await this.list();
    const byId = new Map(targets.map((target) => [target.id, target]));
    const endpoints = targets
      .map((target) => target.endpoint)
      .filter((endpoint): endpoint is ServingEndpointSummary => endpoint !== undefined);
    const ranked = [
      ...modelResolve.lookupModels(endpoints, { search: query }),
      ...modelResolve.lookupModels(endpoints, {
        search: query,
        modelClass: ModelClass.Embedding,
      }),
    ].sort((left, right) => (left.score ?? 0) - (right.score ?? 0));
    return ranked
      .map(({ endpoint }) => byId.get(endpoint.name))
      .filter((target): target is ModelTarget => target !== undefined)
      .filter(
        (target, index, all) => all.findIndex((candidate) => candidate.id === target.id) === index,
      );
  }

  async refresh(): Promise<void> {
    const context = await this.context();
    logger.debug("clearing catalogue", { host: context.host });
    if (context.identity) {
      await modelCatalog.clearServingEndpointsCache(context.host, context.identity);
    }
    await modelCatalog.listServingEndpoints(
      context.client,
      context.host,
      catalogueOptions(context, this.ttlMs),
    );
    logger.debug("refreshed catalogue", { host: context.host });
  }

  private target(endpoint: ServingEndpointSummary): ModelTarget {
    const published = metadata.modelCapabilitiesFor(endpoint);
    const family = endpoint.family?.toLowerCase();
    const openAiFamily = family === "gpt" || family === "openai" || endpoint.name.includes("codex");
    const modelServiceName = normalizedModelServiceName(endpoint.modelServiceName);
    const embeddings =
      endpoint.class === ModelClass.Embedding || endpoint.task === "llm/v1/embeddings";
    const capabilities: ModelCapabilities = {
      responses: !embeddings && (openAiFamily || published.responses),
      openResponses: !embeddings && !openAiFamily,
      chat: !embeddings,
      anthropic: family === "claude",
      embeddings,
      aiGatewayCodex:
        !embeddings && Boolean(modelServiceName) && family !== "claude" && family !== "gemini",
      tools: endpoint.supportsTools === true,
      reasoning: policy.modelReasoningEfforts(endpoint.name).length > 0,
      streaming: true,
      parallelTools: endpoint.supportsTools === true,
      customTools: published.applyPatch || endpoint.name.includes("codex"),
      structuredOutput: true,
      webSearch: published.webSearch,
    };
    const aliases = new Set(
      [
        endpoint.name,
        endpoint.displayName,
        endpoint.modelServiceName,
        modelServiceName,
        ...Object.values(endpoint.serviceNames ?? {}),
      ].filter((value): value is string => Boolean(value?.trim())),
    );
    const override = this.overrides.find(
      (candidate) =>
        candidate.model === endpoint.name ||
        [...aliases].some((alias) => alias === candidate.model),
    );
    return {
      id: endpoint.name,
      aliases: [...aliases],
      displayName: endpoint.displayName ?? endpoint.name,
      ...(endpoint.family ? { family: endpoint.family } : {}),
      ...(modelServiceName ? { modelServiceName } : {}),
      endpoint,
      capabilities: { ...capabilities, ...override?.capabilities },
      reasoningEfforts: endpoint.reasoningEfforts ?? [],
    };
  }

  private async context(): Promise<RegistryContext> {
    if (this.client) {
      const host = (await this.client.config.getHost()).toString();
      return { client: this.client, host };
    }
    return registryContext();
  }
}

function catalogueOptions(context: RegistryContext, ttlMs: number): ListServingEndpointsOptions {
  return {
    ttlMs,
    ...(context.identity ? { cacheIdentity: context.identity } : {}),
  };
}

async function registryContext(): Promise<RegistryContext> {
  const context = getExecutionContext();
  const host = (await context.client.config.getHost()).toString();
  return {
    client: context.client,
    host,
    identity: "userId" in context ? context.userId : context.serviceUserId,
  };
}

function unqualifiedModel(model: string): string {
  return model.trim().replace(/^(?:dbx|databricks)\//i, "");
}

function positiveTtl(value = DEFAULT_CACHE_TTL_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Model registry ttlMs must be a positive finite number");
  }
  return value;
}

function normalizedModelServiceName(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^databricks\//, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("system.ai.databricks-")) {
    return `system.ai.${normalized.slice("system.ai.databricks-".length)}`;
  }
  if (normalized.startsWith("databricks-")) {
    return `system.ai.${normalized.slice("databricks-".length)}`;
  }
  return normalized;
}

function matchesResolveOptions(target: ModelTarget, options: ModelRegistryResolveOptions): boolean {
  if (options.requiresTools && !target.capabilities.tools) return false;
  if (options.modelClass === ModelClass.Embedding) return target.capabilities.embeddings;
  if (options.modelClass !== undefined) return target.capabilities.chat;
  return true;
}
