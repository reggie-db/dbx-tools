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
 * in `@dbx-tools/model` ({@link selectModel}) so non-Mastra consumers
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

import { getExecutionContext } from "@databricks/appkit";
import { classes, policy, resolve } from "@dbx-tools/model";
import { createDatabricksLanguageModel } from "@dbx-tools/model-protocol/provider";
import { log } from "@dbx-tools/shared-core";
import { model, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.ts";
import {
  MASTRA_MODEL_OVERRIDE_KEY,
  MASTRA_RESOLVED_MODEL_KEY,
  resolveServingConfig,
} from "./serving.ts";
import { recordActiveTraceAuth, recordActiveTraceModel } from "./telemetry.ts";

type ModelClass = model.ModelClass;
const { parseModelClass } = classes;
const { selectModel } = resolve;

/** Keep Responses turns stateless so tool continuations replay encrypted reasoning inline. */
export const RESPONSES_PROVIDER_OPTIONS = {
  openai: {
    store: false,
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
   * Chat capability class to resolve when no explicit model id is
   * supplied. Used by internal agents (e.g. the chart planner asks for
   * {@link model.ModelClass.ChatFast}) to express intent without pinning an
   * endpoint name; the live catalogue is classified and the top
   * available model in the class is chosen, falling back to the
   * class's static list when the workspace has none.
   */
  modelClass?: ModelClass;
}

function selectionInput(
  config: MastraPluginConfig,
  requested: string | undefined,
  defaultClass: ModelClass | undefined,
  serving = resolveServingConfig(config),
) {
  const requestedClass = requested !== undefined ? parseModelClass(requested) : null;
  const explicit = requestedClass === null ? requested : undefined;
  const modelClass = requestedClass ?? defaultClass;
  return {
    ...(explicit !== undefined ? { explicit } : {}),
    fuzzy: serving.fuzzy,
    threshold: serving.threshold,
    ...(modelClass !== undefined ? { modelClass } : {}),
    fallbacks: serving.fallbacks.slice(),
    liveOnly: requested === undefined,
    ttlMs: serving.ttlMs,
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
  const requested = overrides.modelId ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  return resolve.resolveModel(endpoints, selectionInput(config, requested, overrides.modelClass))
    .modelId;
}

/**
 * Resolve a `MastraModelConfig` for the current agent step. Runs
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
  requestContext: RequestContext,
  overrides: BuildModelOverrides = {},
): Promise<MastraModelConfig> {
  // The chat path stamps the AppKit user on the request context via
  // `MastraServer`. The MCP transport routes don't thread that context
  // into tool execution, so fall back to the ambient execution context
  // (the active OBO scope, or the service principal) when it's absent.
  const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
  const executionContext = user?.executionContext ?? getExecutionContext();
  recordActiveTraceAuth("isUserContext" in executionContext ? "obo" : "service-principal");
  const clientConfig = executionContext.client.config;
  const host = (await clientConfig.getHost()).toString();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  const logger = log.logger(config);
  const serving = resolveServingConfig(config);
  const override = serving.allowOverride
    ? (requestContext.get(MASTRA_MODEL_OVERRIDE_KEY) as string | undefined)
    : undefined;

  // The override / agent default / env value can be either a concrete
  // endpoint name or a model class slug ("chat-thinking" /
  // "chat-balanced" / "chat-fast"). A class slug becomes a class intent
  // (let the live catalogue pick the best model in that band); anything
  // else is an explicit name fuzzy-matched against the catalogue. An
  // internal `overrides.modelClass` (e.g. the chart planner) is the
  // floor when nothing was requested.
  const requested = override ?? overrides.modelId ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

  const { modelId, source } = await selectModel(
    executionContext.client,
    host,
    selectionInput(config, requested, overrides.modelClass, serving),
  );
  logger.debug("model selected", { modelId, source, requested });
  requestContext.set(MASTRA_RESOLVED_MODEL_KEY, modelId);
  recordActiveTraceModel(modelId);

  return createDatabricksLanguageModel({
    modelId,
    protocol: servingApi(modelId),
    host,
    headers: Object.fromEntries(headers.entries()),
    providerName: config.providerId ?? "openai",
  });
}
