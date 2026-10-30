/**
 * Databricks Model Serving resolver for Mastra agents.
 *
 * Each agent step calls {@link buildModel} with the active
 * `RequestContext`. The user stamped by `MastraServer` carries an
 * AppKit `WorkspaceClient`; we ask it for the workspace host and a
 * fresh bearer header, then construct a request-scoped Vercel AI SDK provider
 * for the endpoint's native Databricks serving protocol.
 *
 * This module only adds the Mastra-specific glue. The actual model
 * selection - listing the workspace catalogue and resolving an
 * explicit name / class / fallback chain to a real endpoint id - lives
 * in `@dbx-tools/model` ({@link selection.resolveModel}) so non-Mastra consumers
 * (e.g. a job that just needs a model name) can reuse it. Here we
 * assemble the explicit ask from Mastra's request context (the
 * per-request override under {@link MASTRA_MODEL_OVERRIDE_KEY}, the
 * agent / plugin `modelId`, or `DATABRICKS_SERVING_ENDPOINT_NAME`),
 * pass the plugin's fuzzy / class / fallback knobs through, and wrap
 * the resolved id in the ProviderV4 model Mastra accepts. Catalogue fetches fail loud: network / auth errors
 * propagate so callers see the real SDK message.
 *
 * @module
 */

import { createWorkspaceClient, type WorkspaceClient } from "@databricks/appkit";
import { tryGetExecutionContext } from "@dbx-tools/appkit";
import { SmartRouterService, smartRouterCandidates } from "@dbx-tools/appkit-model-gateway";
import {
  classes,
  endpointCapabilities,
  listServingEndpoints,
  policy,
  selection,
} from "@dbx-tools/model";
import {
  createDatabricksLanguageModel,
  type DatabricksLanguageModel,
} from "@dbx-tools/model-protocol";
import { log } from "@dbx-tools/shared-core";
import { contracts, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import {
  SMART_ROUTER_MODEL_ID,
  SmartRouterObservationSchema,
  isSmartRouterModelId,
} from "@dbx-tools/shared-model-gateway";
import { RequestContext } from "@mastra/core/request-context";

import {
  executionContextUserId,
  MASTRA_USER_KEY,
  type MastraPluginConfig,
  type User,
} from "./config.ts";
import {
  MASTRA_MODEL_OVERRIDE_KEY,
  MASTRA_MODEL_ROUTE_KEY,
  MASTRA_RESOLVED_MODEL_KEY,
  MASTRA_SMART_ROUTER_INPUT_KEY,
  type MastraModelRoute,
  resolveServingConfig,
} from "./serving.ts";
import { recordActiveTraceAuth, recordActiveTraceModel } from "./telemetry.ts";

type ModelClass = contracts.ModelClass;
type ModelOptimization = contracts.ModelOptimization;
const { parseModelClass } = classes;
const smartRouter = new SmartRouterService();
const MASTRA_SMART_ROUTER_RESOLUTION_KEY = "mastra__smart_router_resolution";

interface SmartRouterModelResolution {
  readonly modelId: string;
  readonly source: MastraModelRoute["selection"] | typeof SMART_ROUTER_MODEL_ID;
  readonly route?: MastraModelRoute;
}

/** Virtual endpoint shown when Smart Router is enabled for the active identity. */
export const SMART_ROUTER_ENDPOINT: ServingEndpointSummary = {
  name: SMART_ROUTER_MODEL_ID,
  displayName: "Smart Router",
  description: "Selects a Databricks system model with the task_v3 Smart Router.",
  task: "llm/v1/chat",
  status: { deprecated: false },
};

/** Default Responses options: stateless replay plus visible reasoning summaries. */
export const RESPONSES_PROVIDER_OPTIONS = {
  openai: {
    store: false,
    reasoningSummary: "auto",
  },
} as const;

/** Pick the native Databricks inference surface required by a resolved model. */
export function servingApi(modelId: string): "chat" | "responses" {
  return policy.modelServingApi(modelId);
}

/** Optional overrides accepted by {@link buildModel}. */
export interface BuildModelOverrides {
  /**
   * Static model id from the agent / plugin config (string sugar on
   * `def.model` or `config.defaultModel`). Loses to the per-request
   * override but wins over env / class / fallback.
   */
  modelId?: string;
  /**
   * Chat capability class for internal model work. When no model id is
   * supplied, this bypasses request and environment model overrides so
   * background tasks such as titles and follow-ups cannot inherit the
   * primary agent's Smart Router selection. The live catalogue chooses
   * the top available model in the class, falling back to the class's
   * static list when the workspace has none.
   */
  modelClass?: ModelClass;
  /** Profile dimension used to rank eligible automatic model candidates. */
  optimizeFor?: ModelOptimization;
  /** Require documented structured-output support for the selected endpoint. */
  requiresStructuredOutput?: boolean;
  /** Arbitrary request, messages, JSON, or text used to build Smart Router task context. */
  smartRouterInput?: unknown;
  /** Explicit workspace client for standalone callers such as CLIs. */
  workspaceClient?: WorkspaceClient;
}

/** Resolved workspace client and the authentication mode backing it. */
interface ResolvedModelWorkspaceClient {
  client: WorkspaceClient;
  auth: "obo" | "service-principal";
  cacheIdentity?: string;
}

/** Resolve an OBO workspace client when present, else a service-principal client. */
function resolveModelWorkspaceContext(
  requestContext?: RequestContext,
): ResolvedModelWorkspaceClient {
  const user = requestContext?.get(MASTRA_USER_KEY) as User | undefined;
  const executionContext = user?.executionContext ?? tryGetExecutionContext();
  if (executionContext?.client.config) {
    return {
      client: executionContext.client,
      auth: "isUserContext" in executionContext ? "obo" : "service-principal",
      cacheIdentity: executionContextUserId(executionContext),
    };
  }
  return { client: createWorkspaceClient(), auth: "service-principal" };
}

/** Resolve the workspace client used for model discovery and inference. */
export function resolveModelWorkspaceClient(requestContext?: RequestContext): WorkspaceClient {
  return resolveModelWorkspaceContext(requestContext).client;
}

function selectionInput(
  config: MastraPluginConfig,
  requested: string | undefined,
  defaultClass: ModelClass | undefined,
  cacheIdentity: string | undefined,
  serving = resolveServingConfig(config),
  optimization?: Pick<BuildModelOverrides, "optimizeFor" | "requiresStructuredOutput">,
) {
  const requestedClass = requested !== undefined ? parseModelClass(requested) : null;
  const explicit = requestedClass === null ? requested : undefined;
  const modelClass = requestedClass ?? defaultClass;
  return {
    ...(explicit !== undefined ? { explicit } : {}),
    fuzzy: serving.fuzzy,
    threshold: serving.threshold,
    ...(modelClass !== undefined ? { modelClass } : {}),
    ...(optimization?.optimizeFor !== undefined ? { optimizeFor: optimization.optimizeFor } : {}),
    ...(optimization?.requiresStructuredOutput !== undefined
      ? { requiresStructuredOutput: optimization.requiresStructuredOutput }
      : {}),
    fallbacks: serving.fallbacks.slice(),
    liveOnly: requested === undefined,
    ttlMs: serving.ttlMs,
    ...(cacheIdentity !== undefined ? { cacheIdentity } : {}),
  };
}

/**
 * Resolve an agent's unpinned default against an already-loaded live catalogue.
 *
 * With no configured id/class/fallback, the generic model ranker selects the
 * highest-ranked currently available GPT, then falls back to the highest-ranked
 * live chat endpoint when the workspace has no GPT.
 */
export function resolveDefaultModelId(
  config: MastraPluginConfig,
  endpoints: readonly ServingEndpointSummary[],
  overrides: BuildModelOverrides = {},
): string {
  if (endpoints.some((endpoint) => endpoint.name === SMART_ROUTER_MODEL_ID)) {
    return SMART_ROUTER_MODEL_ID;
  }
  const requested = overrides.modelId ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  return selection.resolveModel(
    endpoints,
    selectionInput(config, requested, overrides.modelClass, undefined, undefined, overrides),
  ).modelId;
}

/**
 * Resolve a Databricks ProviderV4 model for the current agent step. Runs
 * while `agent.stream` is inside the `asUser(req)` scope so tokens
 * are user-scoped; outside an active user context the workspace
 * client falls back to the service principal.
 *
 * Endpoint precedence: the per-request override
 * ({@link MASTRA_MODEL_OVERRIDE_KEY}, only when `config.modelOverride` allows
 * it), then {@link BuildModelOverrides.modelId} from the agent / plugin
 * config, then `DATABRICKS_SERVING_ENDPOINT_NAME`. With none of those set the
 * capability class and fallback ladder in `@dbx-tools/model` choose the
 * endpoint.
 */
export async function buildModel(
  config: MastraPluginConfig,
  requestContext?: RequestContext,
  overrides: BuildModelOverrides = {},
): Promise<DatabricksLanguageModel> {
  const context = requestContext ?? new RequestContext();
  // The chat path stamps the AppKit user on the request context via
  // `MastraServer`. The MCP transport routes don't thread that context
  // into tool execution, so fall back to the ambient execution context
  // (the active OBO scope, or the service principal) when it's absent.
  const resolved = overrides.workspaceClient
    ? { client: overrides.workspaceClient, auth: "service-principal" as const }
    : resolveModelWorkspaceContext(context);
  const { client, auth, cacheIdentity } = resolved;
  recordActiveTraceAuth(auth);
  const clientConfig = client.config;
  const host = (await clientConfig.getHost()).toString();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  const logger = log.logger(config);
  const serving = resolveServingConfig(config);
  const internalClassOnly = overrides.modelClass !== undefined && overrides.modelId === undefined;
  const override =
    serving.allowOverride && !internalClassOnly
      ? (context.get(MASTRA_MODEL_OVERRIDE_KEY) as string | undefined)
      : undefined;

  // The override / agent default / env value can be either a concrete
  // endpoint name or a model class slug ("chat-thinking" /
  // "chat-balanced" / "chat-fast"). A class slug becomes a class intent
  // (let the live catalogue pick the best model in that band); anything
  // else is an explicit name fuzzy-matched against the catalogue. An
  // internal `overrides.modelClass` (e.g. titles, follow-ups, or the chart
  // planner) is authoritative unless that caller also pins `modelId`. It must
  // not inherit the primary agent's request or environment selection.
  const requested =
    override ??
    overrides.modelId ??
    (!internalClassOnly ? process.env.DATABRICKS_SERVING_ENDPOINT_NAME : undefined);
  const smartRouterInput = overrides.smartRouterInput ?? context.get(MASTRA_SMART_ROUTER_INPUT_KEY);
  const smartRouterRequested = isSmartRouterModelId(requested);
  if (smartRouterRequested && smartRouterInput === undefined) {
    throw new Error("Smart Router requires task input before it can resolve a concrete model");
  }
  let modelId: string;
  let source: MastraModelRoute["selection"] | typeof SMART_ROUTER_MODEL_ID;
  let route: MastraModelRoute | undefined;
  let endpointsPromise: Promise<ServingEndpointSummary[]> | undefined;
  const loadEndpoints = () => {
    endpointsPromise ??= listServingEndpoints(client, host, {
      ttlMs: serving.ttlMs,
      ...(cacheIdentity !== undefined ? { cacheIdentity } : {}),
      measureEmbeddingDimensions: overrides.modelClass === contracts.ModelClass.Embedding,
    });
    return endpointsPromise;
  };
  if (
    (requested === undefined || smartRouterRequested) &&
    overrides.modelClass === undefined &&
    smartRouterInput !== undefined
  ) {
    let pending = context.get(MASTRA_SMART_ROUTER_RESOLUTION_KEY) as
      Promise<SmartRouterModelResolution> | undefined;
    if (!pending) {
      pending = (async () => {
        const endpoints = await loadEndpoints();
        const candidates = smartRouterCandidates(
          endpoints.filter((endpoint) => endpointCapabilities(endpoint).tools),
          "codex",
        );
        // An explicit Smart Router request does not need a synthetic preflight:
        // the real selection is the availability check. Auto mode still probes
        // so it can fall back to the configured model policy when unavailable.
        const enabled = smartRouterRequested || (await smartRouter.isEnabled(candidates, client));
        if (enabled) {
          const selected = await smartRouter.select(smartRouterInput, candidates, { client });
          const observation = SmartRouterObservationSchema.parse({
            selectedModel: selected.value.name,
            routeModel: selected.routeModel,
            harness: selected.harness,
            routerName: selected.routerName,
            source: "router",
            latencyMs: selected.latencyMs,
            ...(selected.rationale ? { rationale: selected.rationale } : {}),
            ...(selected.params ? { params: selected.params } : {}),
          });
          return {
            modelId: selected.value.name,
            source: SMART_ROUTER_MODEL_ID,
            route: {
              model: selected.value.name,
              selection: "smart-router",
              ...(selected.value.profile?.cost !== undefined
                ? { costPerMillionTokens: selected.value.profile.cost }
                : {}),
              smartRouter: observation,
            },
          };
        }
        const fallback = selection.resolveModel(
          endpoints,
          selectionInput(
            config,
            requested,
            overrides.modelClass,
            cacheIdentity,
            serving,
            overrides,
          ),
        );
        return { modelId: fallback.modelId, source: fallback.source };
      })();
      context.set(MASTRA_SMART_ROUTER_RESOLUTION_KEY, pending);
    }
    try {
      ({ modelId, source, route } = await pending);
    } catch (error) {
      if (context.get(MASTRA_SMART_ROUTER_RESOLUTION_KEY) === pending) {
        context.set(MASTRA_SMART_ROUTER_RESOLUTION_KEY, undefined);
      }
      throw error;
    }
  } else {
    const endpoints = await loadEndpoints();
    const resolved = selection.resolveModel(
      endpoints,
      selectionInput(config, requested, overrides.modelClass, cacheIdentity, serving, overrides),
    );
    modelId = resolved.modelId;
    source = resolved.source;
    const endpoint = endpoints.find((candidate) => candidate.name === modelId);
    route = {
      model: modelId,
      selection: source,
      ...(endpoint?.profile?.cost !== undefined
        ? { costPerMillionTokens: endpoint.profile.cost }
        : {}),
    };
  }
  if (isSmartRouterModelId(modelId)) {
    throw new Error("Smart Router did not resolve to a concrete serving endpoint");
  }
  logger.debug("model selected", { modelId, source, requested });
  if (!route) {
    if (source === SMART_ROUTER_MODEL_ID) {
      throw new Error("Smart Router selection metadata is unavailable");
    }
    const endpoints = await loadEndpoints();
    const endpoint = endpoints.find((candidate) => candidate.name === modelId);
    route = {
      model: modelId,
      selection: source,
      ...(endpoint?.profile?.cost !== undefined
        ? { costPerMillionTokens: endpoint.profile.cost }
        : {}),
    };
  }
  context.set(MASTRA_RESOLVED_MODEL_KEY, modelId);
  context.set(MASTRA_MODEL_ROUTE_KEY, route);
  recordActiveTraceModel(modelId);

  return createDatabricksLanguageModel({
    modelId,
    protocol: servingApi(modelId),
    host,
    headers: Object.fromEntries(headers.entries()),
    providerName: config.providerId ?? "openai",
  });
}

/** Append the virtual Smart Router endpoint only after its memoized live probe succeeds. */
export async function withSmartRouterEndpoint(
  endpoints: readonly ServingEndpointSummary[],
  client: WorkspaceClient,
): Promise<ServingEndpointSummary[]> {
  const candidates = smartRouterCandidates(
    endpoints.filter((endpoint) => endpointCapabilities(endpoint).tools),
    "codex",
  );
  return (await smartRouter.isEnabled(candidates, client))
    ? [SMART_ROUTER_ENDPOINT, ...endpoints]
    : [...endpoints];
}
