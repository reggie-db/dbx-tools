/**
 * Foreground model-gateway server owned by the CLI package.
 *
 * @module
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createApp, server } from "@databricks/appkit";
import {
  ModelGateway,
  SmartRouterService,
  SMART_ROUTER_DEFAULT_SETTINGS,
  DatabricksModelRegistry,
  sendHealth,
  sendInference,
  sendModels,
  smartRouterCandidates,
} from "@dbx-tools/appkit-model-gateway";
import { createWorkspaceClient } from "@dbx-tools/databricks";
import {
  resolveModelGatewayOptions,
  type ModelGatewayOptions,
  type ResolvedModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway";
import type express from "express";

type AppKitServerOptions = NonNullable<Parameters<typeof server>[0]>;

/** Resolve AppKit server settings for the loopback model gateway. */
export function modelGatewayServerOptions(options: ModelGatewayOptions = {}): AppKitServerOptions {
  return appKitServerOptions(resolveModelGatewayOptions(options));
}

function appKitServerOptions(options: ResolvedModelGatewayOptions): AppKitServerOptions {
  return {
    bodyLimit: options.bodyLimit,
    host: options.listen.host,
    port: options.listen.port,
  };
}

/** Require one bearer token without retaining or logging request credentials. */
export function gatewayBearerMiddleware(token: string): express.RequestHandler {
  const expected = createHash("sha256").update(token).digest();
  return (request, response, next) => {
    const authorization = request.header("authorization");
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    const actual = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    if (match && timingSafeEqual(actual, expected)) {
      next();
      return;
    }
    response
      .status(401)
      .setHeader("www-authenticate", "Bearer")
      .json({
        error: {
          message: "Invalid or missing model-gateway bearer token.",
          type: "authentication_error",
          code: "invalid_bearer_token",
        },
      });
  };
}

/** Start the foreground model gateway and keep its AppKit server active. */
export async function startModelGateway(options: ModelGatewayOptions = {}): Promise<void> {
  const resolved = resolveModelGatewayOptions(options);
  const gateway = new ModelGateway({
    smartRouter: resolved.smartRouter,
    smartRouterContextTokenBudget: resolved.smartRouterContextTokenBudget,
    smartRouterProbeRefreshIntervalMs: resolved.smartRouterProbeRefreshIntervalMs,
    smartRouterProbeTtlMs: resolved.smartRouterProbeTtlMs,
    smartRouterRouteTtlSeconds: resolved.smartRouterRouteTtlSeconds,
    smartRouterTimeoutMs: resolved.smartRouterTimeoutMs,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.modelClass ? { modelClass: resolved.modelClass } : {}),
    preferSystemModels: resolved.preferSystemModels,
  });
  const client = await createWorkspaceClient({
    ...(resolved.profile ? { profile: resolved.profile } : {}),
  });
  await createApp({
    client,
    plugins: [server(appKitServerOptions(resolved))],
    onPluginsReady(appkit) {
      appkit.server.extend((application) => {
        if (resolved.bearerToken) {
          application.use(gatewayBearerMiddleware(resolved.bearerToken));
        }
        application.get("/api/healthz", (_request, response) => {
          sendHealth(response);
        });
        application.get("/v1/models", (request, response) => {
          void sendModels(gateway, request, response);
        });
        for (const [path, protocol] of [
          ["/v1/chat/completions", "openai-chat"],
          ["/v1/responses", "openai-responses"],
          ["/v1/messages", "anthropic-messages"],
          ["/v1/embeddings", "openai-embeddings"],
        ] as const) {
          application.post(path, (request, response) => {
            void sendInference(gateway, protocol, request, response);
          });
        }
      });
    },
  });
}

/** Select one concrete model from arbitrary file/stdin content and exit. */
export async function selectSmartRouterModel(
  options: ModelGatewayOptions,
  input: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  const resolved = resolveModelGatewayOptions(options);
  const client = await createWorkspaceClient({
    ...(resolved.profile ? { profile: resolved.profile } : {}),
  });
  const registry = new DatabricksModelRegistry({
    client,
    preferSystemModels: resolved.preferSystemModels,
  });
  const targets = (await registry.list()).filter(
    (target) => target.capabilities.chat && target.capabilities.aiGatewayCodex,
  );
  const candidates = smartRouterCandidates(targets, "codex");
  const service = new SmartRouterService({
    ...SMART_ROUTER_DEFAULT_SETTINGS,
    contextTokenBudget: resolved.smartRouterContextTokenBudget,
    probeRefreshIntervalMs: resolved.smartRouterProbeRefreshIntervalMs,
    probeTtlMs: resolved.smartRouterProbeTtlMs,
    routeTtlSeconds: resolved.smartRouterRouteTtlSeconds,
    timeoutMs: resolved.smartRouterTimeoutMs,
  });
  const selected = await service.select(input, candidates, { client });
  return {
    model: selected.value.id,
    modelServiceName: selected.value.modelServiceName,
    routeModel: selected.routeModel,
    harness: selected.harness,
    routerName: selected.routerName,
    latencyMs: selected.latencyMs,
    ...(selected.rationale ? { rationale: selected.rationale } : {}),
    ...(selected.params ? { params: selected.params } : {}),
  };
}
