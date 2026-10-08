/**
 * Protocol-independent gateway service used by plugin and standalone routes.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import {
  ModelClass,
  ModelClassSchema,
  type ModelClass as ModelClassType,
} from "@dbx-tools/shared-model";
import type {
  ClientProtocol,
  GatewayRoute,
  ModelCapabilityOverride,
  ModelListResponse,
} from "@dbx-tools/shared-model-gateway";

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

/** Model gateway runtime configuration. */
export interface ModelGatewayOptions {
  readonly cacheTtlMs?: number;
  readonly overrides?: readonly ModelCapabilityOverride[];
  readonly model?: string;
  readonly modelClass?: ModelClassType;
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
  private readonly model?: string;
  private readonly modelClass?: ModelClassType;

  constructor(options: ModelGatewayOptions = {}, registry?: ModelRegistry) {
    const registryOptions: ModelRegistryOptions = {
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    };
    this.registry = registry ?? new DatabricksModelRegistry(registryOptions);
    this.model = options.model;
    this.modelClass = options.modelClass;
  }

  /** Return the live OpenAI model list, including Codex metadata when requested. */
  async models(originator?: string, search?: string): Promise<ModelListResponse> {
    const codex = isCodexOriginator(originator);
    logger.debug("listing models", { codex, search });
    const query = search?.trim();
    const targets = query ? await this.registry.search(query) : await this.registry.list();
    logger.debug("listed models", { codex, count: targets.length });
    return listModelsPayload(targets, codex, query !== undefined && query.length > 0);
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
      clientProtocol: protocol,
      model: selection.model,
      modelClass: selection.modelClass,
      originator: headers.get("originator") ?? undefined,
      stream: sanitizedBody.stream === true,
    });
    const features = requestedFeatures(sanitizedBody);
    const target = await this.registry.resolve(selection.model, {
      ...(protocol === "openai-embeddings" ? { modelClass: ModelClass.Embedding } : {}),
      ...(selection.modelClass ? { modelClass: selection.modelClass } : {}),
      ...(features.tools ? { requiresTools: true } : {}),
    });
    if (!target) {
      throw new ModelGatewayError(
        404,
        selection.model
          ? `Model not found: ${selection.model}`
          : "No model matches the requested class",
      );
    }
    const requestedModel = selection.model ?? target.id;
    const route = resolveRoute({
      clientProtocol: protocol,
      requestedModel,
      originator: headers.get("originator") ?? undefined,
      features,
      target,
    });
    logger.debug("routed", {
      clientProtocol: protocol,
      model: target.id,
      upstreamProtocol: route.upstreamProtocol,
    });

    const adapted = adaptInferenceReasoning(target.id, sanitizedBody);
    let response = await this.forward(route, adapted.body, headers, signal);
    const retryBody = await learnAndAdaptReasoningRetry({
      model: target.id,
      body: sanitizedBody,
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
      return response;
    }
    const forwarded = gatewayResponseHeaders(response.headers);
    forwarded.set("x-dbx-tools-upstream", route.upstreamProtocol);
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

/** Remove an explicit null temperature while preserving omitted and numeric values. */
export function sanitizeInferenceBody(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (body.temperature !== null) return body;
  const sanitized = { ...body };
  delete sanitized.temperature;
  return sanitized;
}

/** Resolve request, header, configured, and protocol model-selection inputs. */
export function gatewayModelSelection(
  body: Readonly<Record<string, unknown>>,
  headers: Headers,
  defaults: { readonly model?: string; readonly modelClass?: ModelClassType } = {},
  protocol?: ClientProtocol,
): { readonly model?: string; readonly modelClass?: ModelClassType } {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  const header = headers.get("x-dbx-tools-model-class")?.trim();
  const parsedClass = header ? ModelClassSchema.safeParse(header) : undefined;
  if (parsedClass && !parsedClass.success) {
    throw new ModelGatewayError(400, `Invalid model class: ${header}`);
  }
  if (model && parsedClass?.data) {
    throw new ModelGatewayError(400, "Model and model class are mutually exclusive");
  }
  if (model) return { model };
  if (parsedClass?.data) return { modelClass: parsedClass.data };
  if (defaults.model) return { model: defaults.model };
  if (defaults.modelClass) return { modelClass: defaults.modelClass };
  if (protocol === "openai-embeddings") return { modelClass: ModelClass.Embedding };
  return {};
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
