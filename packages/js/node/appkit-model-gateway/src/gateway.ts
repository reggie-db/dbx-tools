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
  type AutomaticRouteObservation,
  type ServingEndpointSummary,
  type ModelClass as ModelClassType,
} from "@dbx-tools/shared-model";
import type {
  ClientProtocol,
  GatewayRoute,
  ModelCapabilityOverride,
  ModelListResponse,
} from "@dbx-tools/shared-model-gateway";
import {
  AUTOMATIC_CONFIDENCE_HEADER,
  AUTOMATIC_DEGRADED_HEADER,
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_REASON_CODE_HEADER,
  AUTOMATIC_REASONING_HEADER,
  AUTOMATIC_SELECTED_MODEL_HEADER,
  AUTOMATIC_SOURCE_HEADER,
  AUTOMATIC_TIER_HEADER,
  MODEL_GATEWAY_DEFAULTS,
  isAutomaticModelId,
} from "@dbx-tools/shared-model-gateway";

import {
  AutomaticModelRouter,
  type AutomaticRouteSelector,
  type AutomaticRouteStore,
} from "./automatic-routing.ts";
import { listModelsPayload } from "./models.ts";
import { adaptInferenceReasoning, learnAndAdaptReasoningRetry } from "./reasoning-adapt.ts";
import {
  DatabricksModelRegistry,
  type ModelRegistry,
  type ModelRegistryOptions,
} from "./registry.ts";
import { isCodexOriginator, requestedFeatures, resolveRoute } from "./router.ts";
import { translateGatewayRequest } from "./translation.ts";
import { fetchDatabricks, gatewayResponseHeaders } from "./transport.ts";

const logger = log.logger("appkit/model-gateway");
const DATABRICKS_TEMPERATURE_MIN = 0;
const DATABRICKS_TEMPERATURE_MAX = 2;

/** Model gateway runtime configuration. */
export interface ModelGatewayOptions {
  readonly cacheTtlMs?: number;
  readonly automaticRouting?: boolean;
  readonly automaticSelectorModel?: string;
  readonly automaticSelectorTokenBudget?: number;
  readonly automaticSelectorTimeoutMs?: number;
  readonly automaticMinimumConfidence?: number;
  readonly automaticPreferCostEfficientModels?: boolean;
  readonly automaticRouteTtlSeconds?: number;
  readonly automaticSelector?: AutomaticRouteSelector;
  readonly automaticRouteStore?: AutomaticRouteStore;
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
  private readonly automaticRouter?: AutomaticModelRouter;
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
    if (options.automaticRouting ?? MODEL_GATEWAY_DEFAULTS.automaticRouting) {
      this.automaticRouter = new AutomaticModelRouter(
        {
          selectorModel:
            options.automaticSelectorModel ?? MODEL_GATEWAY_DEFAULTS.automaticSelectorModel,
          selectorTokenBudget:
            options.automaticSelectorTokenBudget ??
            MODEL_GATEWAY_DEFAULTS.automaticSelectorTokenBudget,
          selectorTimeoutMs:
            options.automaticSelectorTimeoutMs ?? MODEL_GATEWAY_DEFAULTS.automaticSelectorTimeoutMs,
          minimumConfidence:
            options.automaticMinimumConfidence ?? MODEL_GATEWAY_DEFAULTS.automaticMinimumConfidence,
          preferCostEfficientModels:
            options.automaticPreferCostEfficientModels ??
            MODEL_GATEWAY_DEFAULTS.automaticPreferCostEfficientModels,
          routeTtlSeconds:
            options.automaticRouteTtlSeconds ?? MODEL_GATEWAY_DEFAULTS.automaticRouteTtlSeconds,
        },
        options.automaticSelector,
        options.automaticRouteStore,
      );
    }
    this.model = options.model;
    this.modelClass = options.modelClass;
    this.preferSystemModels =
      options.preferSystemModels ?? MODEL_GATEWAY_DEFAULTS.preferSystemModels;
  }

  /** Return the live OpenAI model list, including Codex metadata when requested. */
  async models(originator?: string, search?: string): Promise<ModelListResponse> {
    const codex = isCodexOriginator(originator);
    logger.debug("listing models", { codex, search });
    const query = search?.trim();
    const targets = query ? await this.registry.search(query) : await this.registry.list();
    logger.debug("listed models", { codex, count: targets.length });
    return listModelsPayload(
      targets,
      codex,
      query !== undefined && query.length > 0,
      this.preferSystemModels,
      Boolean(this.automaticRouter) && (!query || AUTOMATIC_MODEL_ID.includes(query.toLowerCase())),
    );
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
      automatic: selection.automatic === true,
      clientProtocol: protocol,
      model: selection.model,
      modelClass: selection.modelClass,
      originator: headers.get("originator") ?? undefined,
      stream: sanitizedBody.stream === true,
    });
    const features = requestedFeatures(sanitizedBody);
    if (selection.automatic && protocol === "openai-embeddings") {
      throw new ModelGatewayError(400, "Model auto is available only for chat requests");
    }
    const automatic =
      selection.automatic && this.automaticRouter
        ? await this.automaticRouter.resolve({
            protocol: protocol as Exclude<ClientProtocol, "openai-embeddings">,
            body: sanitizedBody,
            headers,
            features,
            targets: await this.registry.list(),
            preferSystemModels: this.preferSystemModels,
            signal,
          })
        : undefined;
    if (selection.automatic && !automatic) {
      throw new ModelGatewayError(404, "Automatic model routing is disabled");
    }
    const target =
      automatic?.target ??
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
      ...(!automatic && selection.model ? { requestedModel: selection.model } : {}),
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
      automatic?.body ?? sanitizedBody,
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
      if (automatic) applyAutomaticObservationHeaders(response.headers, automatic.observation);
      return response;
    }
    const forwarded = gatewayResponseHeaders(response.headers);
    forwarded.set("x-dbx-tools-upstream", route.upstreamProtocol);
    if (automatic) applyAutomaticObservationHeaders(forwarded, automatic.observation);
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
  readonly automatic?: boolean;
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
  if (model) return isAutomaticModelId(model) ? { automatic: true } : { model };
  if (parsedClass?.data) return { modelClass: parsedClass.data };
  if (defaults.model) {
    return isAutomaticModelId(defaults.model) ? { automatic: true } : { model: defaults.model };
  }
  if (defaults.modelClass) return { modelClass: defaults.modelClass };
  if (protocol === "openai-embeddings") return { modelClass: ModelClass.Embedding };
  return {};
}

function applyAutomaticObservationHeaders(
  headers: Headers,
  observation: AutomaticRouteObservation,
): void {
  headers.set(AUTOMATIC_SELECTED_MODEL_HEADER, observation.selectedModel);
  headers.set(AUTOMATIC_TIER_HEADER, observation.tier);
  headers.set(AUTOMATIC_CONFIDENCE_HEADER, String(observation.confidence));
  headers.set(AUTOMATIC_SOURCE_HEADER, observation.source);
  headers.set(AUTOMATIC_REASON_CODE_HEADER, observation.reasonCode);
  headers.set(AUTOMATIC_DEGRADED_HEADER, String(observation.degraded));
  if (observation.reasoningEffort) {
    headers.set(AUTOMATIC_REASONING_HEADER, observation.reasoningEffort);
  }
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
