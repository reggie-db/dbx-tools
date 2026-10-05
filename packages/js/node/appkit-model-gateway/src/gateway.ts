/**
 * Protocol-independent gateway service used by plugin and standalone routes.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import { ModelClass } from "@dbx-tools/shared-model";
import type {
  ClientProtocol,
  GatewayRoute,
  ModelCapabilityOverride,
  ModelListResponse,
} from "@dbx-tools/shared-model-gateway";

import { listModelsPayload } from "./models.ts";
import {
  DatabricksModelRegistry,
  type ModelRegistry,
  type ModelRegistryOptions,
} from "./registry.ts";
import {
  adaptInferenceReasoning,
  learnAndAdaptReasoningRetry,
} from "./reasoning-adapt.ts";
import { isCodexOriginator, requestedFeatures, resolveRoute } from "./router.ts";
import { translateGatewayRequest } from "./translation.ts";
import { fetchDatabricks, gatewayResponseHeaders } from "./transport.ts";

const logger = log.logger("appkit/model-gateway");

/** Model gateway runtime configuration. */
export interface ModelGatewayOptions {
  readonly cacheTtlMs?: number;
  readonly overrides?: readonly ModelCapabilityOverride[];
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

  constructor(options: ModelGatewayOptions = {}, registry?: ModelRegistry) {
    const registryOptions: ModelRegistryOptions = {
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    };
    this.registry = registry ?? new DatabricksModelRegistry(registryOptions);
  }

  /** Return the live OpenAI model list, including Codex metadata when requested. */
  async models(originator?: string, search?: string): Promise<ModelListResponse> {
    const codex = isCodexOriginator(originator);
    logger.debug("listing models", { codex, search });
    const targets = search?.trim()
      ? await this.registry.search(search.trim())
      : await this.registry.list();
    logger.debug("listed models", { codex, count: targets.length });
    return listModelsPayload(targets, codex);
  }

  /** Resolve and execute one inference request. */
  async inference(
    protocol: ClientProtocol,
    body: Readonly<Record<string, unknown>>,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    const requestedModel = requiredModel(body.model);
    logger.debug("resolving request", {
      clientProtocol: protocol,
      model: requestedModel,
      originator: headers.get("originator") ?? undefined,
      stream: body.stream === true,
    });
    const features = requestedFeatures(body);
    const target = await this.registry.resolve(requestedModel, {
      ...(protocol === "openai-embeddings" ? { modelClass: ModelClass.Embedding } : {}),
      ...(features.tools ? { requiresTools: true } : {}),
    });
    if (!target) throw new ModelGatewayError(404, `Model not found: ${requestedModel}`);
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

    const adapted = adaptInferenceReasoning(target.id, body);
    let response = await this.forward(route, adapted.body, headers, signal);
    const retryBody = await learnAndAdaptReasoningRetry({
      model: target.id,
      body,
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

function requiredModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelGatewayError(400, "Request body must include a non-empty model");
  }
  return value.trim();
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
