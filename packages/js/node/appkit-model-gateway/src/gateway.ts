/**
 * Protocol-independent gateway service used by plugin and standalone routes.
 *
 * @module
 */

import { modelTemperatureSupportFor } from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";
import {
  ModelClass,
  ModelClassSchema,
  type ModelSource,
  type ServingEndpointSummary,
  type ModelClass as ModelClassType,
} from "@dbx-tools/shared-model";
import type {
  AiDecideObservation,
  ClientProtocol,
  GatewayRoute,
  ModelCapabilityOverride,
  ModelListResponse,
  SmartRouterObservation,
  SmartRouterMode,
} from "@dbx-tools/shared-model-gateway";
import {
  AI_DECIDE_CONFIDENCE_HEADER,
  AI_DECIDE_MODEL_ID,
  AI_DECIDE_SELECTED_MODEL_HEADER,
  AI_DECIDE_STRATEGY_HEADER,
  AiDecideStrategySchema,
  MODEL_GATEWAY_DEFAULTS,
  SMART_ROUTER_HARNESS_HEADER,
  SMART_ROUTER_MODEL_ID,
  SMART_ROUTER_PROFILER_STATUS_HEADER,
  SMART_ROUTER_ROUTE_MODEL_HEADER,
  SMART_ROUTER_SELECTED_MODEL_HEADER,
  SMART_ROUTER_SERVED_TIER_HEADER,
  SMART_ROUTER_SOURCE_HEADER,
  SMART_ROUTER_TASK_TIER_HEADER,
  isAiDecideModelId,
  isSmartRouterModelId,
} from "@dbx-tools/shared-model-gateway";

import { AiDecideRouterService } from "./ai-decide.ts";
import { listModelsPayload } from "./models.ts";
import { adaptInferenceReasoning, learnAndAdaptReasoningRetry } from "./reasoning-adapt.ts";
import {
  DatabricksModelRegistry,
  type ModelRegistry,
  type ModelRegistryOptions,
} from "./registry.ts";
import { isCodexOriginator, requestedFeatures, resolveRoute } from "./router.ts";
import {
  SmartModelRouter,
  type SmartRouterService,
  type SmartRouterStore,
} from "./smart-router.ts";
import { translateGatewayRequest } from "./translation.ts";
import { fetchDatabricks, gatewayResponseHeaders } from "./transport.ts";

const logger = log.logger("appkit/model-gateway");
const DATABRICKS_TEMPERATURE_MIN = 0;
const DATABRICKS_TEMPERATURE_MAX = 2;

/** Model gateway runtime configuration. */
export interface ModelGatewayOptions {
  readonly cacheTtlMs?: number;
  readonly smartRouter?: SmartRouterMode;
  readonly smartRouterContextTokenBudget?: number;
  readonly smartRouterProbeRefreshIntervalMs?: number;
  readonly smartRouterProbeTtlMs?: number;
  readonly smartRouterRouteTtlSeconds?: number;
  readonly smartRouterTimeoutMs?: number;
  readonly smartRouterService?: SmartRouterService;
  readonly smartRouterStore?: SmartRouterStore;
  readonly aiDecideService?: AiDecideRouterService;
  readonly overrides?: readonly ModelCapabilityOverride[];
  readonly model?: string;
  readonly modelClass?: ModelClassType;
  readonly preferSystemModels?: boolean;
}

/** Error carrying an HTTP status and protocol-safe message. */
export class ModelGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** AppKit-scoped model gateway with dynamic model discovery and streaming inference. */
export class ModelGateway {
  private readonly registry: ModelRegistry;
  private readonly smartRouter?: SmartModelRouter;
  private readonly aiDecide: AiDecideRouterService;
  private readonly smartRouterMode: SmartRouterMode;
  private readonly model?: string;
  private readonly modelClass?: ModelClassType;
  private readonly preferSystemModels: boolean;

  constructor(options: ModelGatewayOptions = {}, registry?: ModelRegistry) {
    const registryOptions: ModelRegistryOptions = {
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
      ...(options.preferSystemModels !== undefined
        ? { preferSystemModels: options.preferSystemModels }
        : {}),
    };
    this.registry = registry ?? new DatabricksModelRegistry(registryOptions);
    this.aiDecide = options.aiDecideService ?? new AiDecideRouterService();
    this.smartRouterMode = options.smartRouter ?? MODEL_GATEWAY_DEFAULTS.smartRouter;
    if (this.smartRouterMode !== "false") {
      this.smartRouter = new SmartModelRouter(
        {
          contextTokenBudget:
            options.smartRouterContextTokenBudget ??
            MODEL_GATEWAY_DEFAULTS.smartRouterContextTokenBudget,
          probeRefreshIntervalMs:
            options.smartRouterProbeRefreshIntervalMs ??
            MODEL_GATEWAY_DEFAULTS.smartRouterProbeRefreshIntervalMs,
          probeTtlMs: options.smartRouterProbeTtlMs ?? MODEL_GATEWAY_DEFAULTS.smartRouterProbeTtlMs,
          routeTtlSeconds:
            options.smartRouterRouteTtlSeconds ?? MODEL_GATEWAY_DEFAULTS.smartRouterRouteTtlSeconds,
          routerName: "task_v3",
          timeoutMs: options.smartRouterTimeoutMs ?? MODEL_GATEWAY_DEFAULTS.smartRouterTimeoutMs,
        },
        options.smartRouterService,
        options.smartRouterStore,
      );
    }
    this.model = options.model;
    this.modelClass = options.modelClass;
    this.preferSystemModels =
      options.preferSystemModels ?? MODEL_GATEWAY_DEFAULTS.preferSystemModels;
  }

  /** Return the live OpenAI model list, including Codex metadata when requested. */
  async models(
    originator?: string,
    search?: string,
    modelSource: ModelSource | "all" = "foundation",
  ): Promise<ModelListResponse> {
    const codex = isCodexOriginator(originator);
    logger.debug("listing models", { codex, search });
    const query = search?.trim();
    const smartRouterSearch =
      query !== undefined && SMART_ROUTER_MODEL_ID.includes(query.toLowerCase());
    const aiDecideSearch =
      query !== undefined && AI_DECIDE_MODEL_ID.includes(query.toLowerCase());
    const discovered =
      query && !smartRouterSearch && !aiDecideSearch
        ? await this.registry.search(query)
        : await this.registry.list();
    const targets =
      modelSource === "all"
        ? discovered
        : discovered.filter((target) => target.endpoint?.modelSource === modelSource);
    const smartRouterTargets =
      this.smartRouterMode === "true" && query && !smartRouterSearch
        ? (await this.registry.list()).filter(
            (target) =>
              modelSource === "all" ||
              target.endpoint?.modelSource === modelSource,
          )
        : targets;
    const shouldProbeSmartRouter =
      Boolean(this.smartRouter) && (this.smartRouterMode === "true" || !query || smartRouterSearch);
    const smartRouterEnabled =
      shouldProbeSmartRouter && (await this.smartRouter!.isEnabled(smartRouterTargets));
    const aiDecideEnabled =
      (!query || aiDecideSearch) &&
      (await this.aiDecide.isEnabled(
        targets
          .map((target) => target.endpoint)
          .filter((endpoint): endpoint is ServingEndpointSummary => endpoint !== undefined),
      ));
    if (this.smartRouterMode === "true" && !smartRouterEnabled) {
      throw new ModelGatewayError(
        503,
        "Databricks Smart Router is required but unavailable for the active workspace identity",
      );
    }
    logger.debug("listed models", { codex, count: targets.length });
    const payload = listModelsPayload(
      targets,
      codex,
      query !== undefined && query.length > 0,
      this.preferSystemModels,
      smartRouterEnabled && (!query || smartRouterSearch),
      aiDecideEnabled && (!query || aiDecideSearch),
    );
    return smartRouterSearch || aiDecideSearch
      ? onlyVirtualModel(payload, smartRouterSearch ? SMART_ROUTER_MODEL_ID : AI_DECIDE_MODEL_ID)
      : payload;
  }

  /** Resolve and execute one inference request. */
  async inference(
    protocol: ClientProtocol,
    body: Readonly<Record<string, unknown>>,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    const sanitizedBody = sanitizeInferenceBody(body);
    const selection = gatewayModelSelection(
      sanitizedBody,
      headers,
      {
        model: this.model,
        modelClass: this.modelClass,
      },
      protocol,
    );
    logger.debug("resolving request", {
      smartRouter: selection.smartRouter === true,
      aiDecide: selection.aiDecide === true,
      clientProtocol: protocol,
      model: selection.model,
      modelClass: selection.modelClass,
      originator: headers.get("originator") ?? undefined,
      stream: sanitizedBody.stream === true,
    });
    const features = requestedFeatures(sanitizedBody);
    if ((selection.smartRouter || selection.aiDecide) && protocol === "openai-embeddings") {
      throw new ModelGatewayError(400, "Virtual model routers are available only for chat requests");
    }
    const smartRouter =
      selection.smartRouter && this.smartRouter
        ? await this.smartRouter.resolve({
            protocol: protocol as Exclude<ClientProtocol, "openai-embeddings">,
            body: sanitizedBody,
            headers,
            features,
            targets: await this.registry.list(),
            preferSystemModels: this.preferSystemModels,
            signal,
          })
        : undefined;
    if (selection.smartRouter && !smartRouter) {
      throw new ModelGatewayError(404, "Databricks Smart Router is disabled");
    }
    const registryTargets = smartRouter ? undefined : await this.registry.list();
    const aiDecide = selection.aiDecide
      ? await this.aiDecide.select(
          sanitizedBody,
          (registryTargets ?? [])
            .map((candidate) => candidate.endpoint)
            .filter((endpoint): endpoint is ServingEndpointSummary => endpoint !== undefined),
          undefined,
          {
            strategy: aiDecideStrategy(headers),
            filters: {
              ...(features.tools ? { requiresTools: true } : {}),
              ...(features.structuredOutput ? { requiresStructuredOutput: true } : {}),
            },
            signal,
          },
        )
      : undefined;
    const target =
      smartRouter?.target ??
      (aiDecide
        ? registryTargets?.find((candidate) => candidate.id === aiDecide.endpoint.name)
        : undefined) ??
      (await this.registry.resolve(selection.model, {
        ...(protocol === "openai-embeddings" ? { modelClass: ModelClass.Embedding } : {}),
        ...(selection.modelClass ? { modelClass: selection.modelClass } : {}),
        ...(features.tools ? { requiresTools: true } : {}),
      }));
    if (!target) {
      throw new ModelGatewayError(
        404,
        selection.model
          ? `Model not found: ${selection.model}`
          : "No model matches the requested class",
      );
    }
    const route = resolveRoute({
      clientProtocol: protocol,
      ...(!smartRouter && !aiDecide && selection.model ? { requestedModel: selection.model } : {}),
      originator: headers.get("originator") ?? undefined,
      preferSystemModels: this.preferSystemModels,
      features,
      target,
    });
    logger.debug("routed", {
      clientProtocol: protocol,
      model: target.id,
      upstreamProtocol: route.upstreamProtocol,
    });

    const temperatureBody = adaptInferenceTemperature(
      target.endpoint ?? target.id,
      smartRouter?.body ?? sanitizedBody,
    );
    const adapted = adaptInferenceReasoning(target.id, temperatureBody);
    let response = await this.forward(route, adapted.body, headers, signal);
    const retryBody = await learnAndAdaptReasoningRetry({
      model: target.id,
      body: temperatureBody,
      response,
      previousWireEffort: adapted.wireEffort,
    });
    if (retryBody) {
      await response.body?.cancel().catch(() => undefined);
      response = await this.forward(route, retryBody, headers, signal);
    }

    logResponse(route.upstreamProtocol, target.id, response);
    if (route.upstreamProtocol === "ai-sdk") {
      response.headers.set("x-dbx-tools-upstream", route.upstreamProtocol);
      if (smartRouter) {
        applySmartRouterObservationHeaders(response.headers, smartRouter.observation);
      }
      if (aiDecide) applyAiDecideObservationHeaders(response.headers, aiDecide.observation);
      return response;
    }
    const forwarded = gatewayResponseHeaders(response.headers);
    forwarded.set("x-dbx-tools-upstream", route.upstreamProtocol);
    if (smartRouter) applySmartRouterObservationHeaders(forwarded, smartRouter.observation);
    if (aiDecide) applyAiDecideObservationHeaders(forwarded, aiDecide.observation);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: forwarded,
    });
  }

  /** Refresh the active principal's model catalogue. */
  refresh(): Promise<void> {
    logger.debug("refreshing model catalogue");
    return this.registry.refresh();
  }

  private async forward(
    route: GatewayRoute,
    body: Readonly<Record<string, unknown>>,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    if (route.upstreamProtocol === "ai-sdk") {
      return translateGatewayRequest(route, body, signal);
    }
    return fetchDatabricks({ route, body, headers, signal });
  }
}

/** Remove null temperature and reject explicit nonnumeric values. */
export function sanitizeInferenceBody(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!Object.hasOwn(body, "temperature")) return body;
  if (body.temperature !== null) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      throw new ModelGatewayError(400, "temperature must be a finite number, null, or omitted");
    }
    return body;
  }
  const sanitized = { ...body };
  delete sanitized.temperature;
  return sanitized;
}

/** Apply published Databricks temperature support and range policy. */
export function adaptInferenceTemperature(
  model: string | ServingEndpointSummary,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!Object.hasOwn(body, "temperature") || typeof body.temperature !== "number") return body;
  const supported = modelTemperatureSupportFor(model);
  if (supported === undefined) return body;
  if (!supported) {
    const adapted = { ...body };
    delete adapted.temperature;
    return adapted;
  }
  const temperature = Math.min(
    DATABRICKS_TEMPERATURE_MAX,
    Math.max(DATABRICKS_TEMPERATURE_MIN, body.temperature),
  );
  return temperature === body.temperature ? body : { ...body, temperature };
}

/** Resolve request, header, configured, and protocol model-selection inputs. */
export function gatewayModelSelection(
  body: Readonly<Record<string, unknown>>,
  headers: Headers,
  defaults: { readonly model?: string; readonly modelClass?: ModelClassType } = {},
  protocol?: ClientProtocol,
): {
  readonly smartRouter?: boolean;
  readonly aiDecide?: boolean;
  readonly model?: string;
  readonly modelClass?: ModelClassType;
} {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  const header = headers.get("x-dbx-tools-model-class")?.trim();
  const parsedClass = header ? ModelClassSchema.safeParse(header) : undefined;
  if (parsedClass && !parsedClass.success) {
    throw new ModelGatewayError(400, `Invalid model class: ${header}`);
  }
  if (model && parsedClass?.data) {
    throw new ModelGatewayError(400, "Model and model class are mutually exclusive");
  }
  if (model) {
    if (isSmartRouterModelId(model)) return { smartRouter: true };
    if (isAiDecideModelId(model)) return { aiDecide: true };
    return { model };
  }
  if (parsedClass?.data) return { modelClass: parsedClass.data };
  if (defaults.model) {
    if (isSmartRouterModelId(defaults.model)) return { smartRouter: true };
    if (isAiDecideModelId(defaults.model)) return { aiDecide: true };
    return { model: defaults.model };
  }
  if (defaults.modelClass) return { modelClass: defaults.modelClass };
  if (protocol === "openai-embeddings") return { modelClass: ModelClass.Embedding };
  return {};
}

function applySmartRouterObservationHeaders(
  headers: Headers,
  observation: SmartRouterObservation,
): void {
  headers.set(SMART_ROUTER_SELECTED_MODEL_HEADER, observation.selectedModel);
  headers.set(SMART_ROUTER_ROUTE_MODEL_HEADER, observation.routeModel);
  headers.set(SMART_ROUTER_HARNESS_HEADER, observation.harness);
  headers.set(SMART_ROUTER_SOURCE_HEADER, observation.source);
  const taskTier = stringParam(observation.params, "task_tier");
  const servedTier = stringParam(observation.params, "served_tier");
  const profilerStatus = stringParam(observation.params, "profiler_status");
  if (taskTier) headers.set(SMART_ROUTER_TASK_TIER_HEADER, taskTier);
  if (servedTier) headers.set(SMART_ROUTER_SERVED_TIER_HEADER, servedTier);
  if (profilerStatus) headers.set(SMART_ROUTER_PROFILER_STATUS_HEADER, profilerStatus);
}

function applyAiDecideObservationHeaders(headers: Headers, observation: AiDecideObservation): void {
  headers.set(AI_DECIDE_SELECTED_MODEL_HEADER, observation.selectedModel);
  headers.set(AI_DECIDE_STRATEGY_HEADER, observation.strategy);
  if (observation.confidence !== undefined) {
    headers.set(AI_DECIDE_CONFIDENCE_HEADER, String(observation.confidence));
  }
}

function aiDecideStrategy(headers: Headers) {
  const value = headers.get(AI_DECIDE_STRATEGY_HEADER)?.trim().toLowerCase();
  return value ? AiDecideStrategySchema.parse(value) : "balanced";
}

function stringParam(
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function onlyVirtualModel(payload: ModelListResponse, modelId: string): ModelListResponse {
  if ("models" in payload) {
    return {
      models: payload.models.filter((model) =>
        model.slug.toLowerCase().endsWith(`/${modelId}`),
      ),
    };
  }
  return {
    object: "list",
    data: payload.data.filter((model) => model.id === modelId),
  };
}

function logResponse(upstreamProtocol: string, model: string, response: Response): void {
  const details = {
    contentType: response.headers.get("content-type"),
    model,
    status: response.status,
    upstreamProtocol,
  };
  if (response.ok) logger.debug("upstream response", details);
  else logger.warn("upstream request failed", details);
}
