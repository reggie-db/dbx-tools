/**
 * Databricks Model Serving resolver for Mastra agents.
 *
 * Each agent step calls {@link buildModel} with the active
 * `RequestContext`. The user stamped by `MastraServer` carries an
 * AppKit `WorkspaceClient`; we ask it for the workspace host and a
 * fresh bearer header, then point Mastra's OpenAI-compatible provider
 * at `/serving-endpoints` on that host.
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
 * the resolved id in the OpenAI-compatible provider config Mastra
 * expects. Catalogue fetches fail loud: network / auth errors
 * propagate so callers see the real SDK message.
 *
 * @module
 */

import { getExecutionContext } from "@databricks/appkit";
import { classes, resolve } from "@dbx-tools/model";
import { functionModule, json, log, net } from "@dbx-tools/shared-core";
import { model } from "@dbx-tools/shared-model";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type MastraPluginConfig, type User } from "./config.ts";
import { rewriteServingBody, rewriteServingResponseBody } from "./serving-sanitize.ts";
import { MASTRA_MODEL_OVERRIDE_KEY, resolveServingConfig } from "./serving.ts";

type ModelClass = model.ModelClass;
const { parseModelClass } = classes;
const { selectModel } = resolve;

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
  void setupFetchInterceptor();
  // The chat path stamps the AppKit user on the request context via
  // `MastraServer`. The MCP transport routes don't thread that context
  // into tool execution, so fall back to the ambient execution context
  // (the active OBO scope, or the service principal) when it's absent.
  const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
  const executionContext = user?.executionContext ?? getExecutionContext();
  const clientConfig = executionContext.client.config;
  const host = (await clientConfig.getHost()).toString();
  const headers = new Headers();
  await clientConfig.authenticate(headers);
  // The OpenAI Node SDK appends paths like `/chat/completions` to whatever
  // URL we hand it. Drop the trailing slash so the resulting URL stays
  // well-formed (`/serving-endpoints/chat/completions`).
  const url = new URL("/serving-endpoints", host).toString().replace(/\/$/, "");

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
  const requestedClass = requested !== undefined ? parseModelClass(requested) : null;
  const explicit = requestedClass === null ? requested : undefined;
  const modelClass = requestedClass ?? overrides.modelClass;

  const { modelId, source } = await selectModel(executionContext.client, host, {
    ...(explicit !== undefined ? { explicit } : {}),
    fuzzy: serving.fuzzy,
    threshold: serving.threshold,
    ...(modelClass !== undefined ? { modelClass } : {}),
    fallbacks: serving.fallbacks,
    ttlMs: serving.ttlMs,
  });
  logger.debug("model selected", { modelId, source, requested });

  return {
    providerId: config.providerId ?? "databricks",
    modelId,
    url,
    headers: Object.fromEntries(headers.entries()),
  };
}

/** Path prefix that identifies a Databricks Model Serving REST call. */
const SERVING_ENDPOINTS_PATH_PREFIX = "/serving-endpoints/";

/**
 * Install a single shared `globalThis.fetch` wrapper for every POST to
 * `/serving-endpoints/...`. The wrapper does two things:
 *
 *   1. Rewrites the outgoing `messages` array to repair Mastra/AI SDK
 *      stream-replay quirks that Databricks-hosted Claude rejects (see
 *      {@link rewriteServingBody} in `./serving-sanitize.js`).
 *   2. At `LOG_LEVEL=debug`, dumps the (post-sanitize) JSON body so
 *      4xx debugging doesn't have to fight AI SDK's `[Array]`
 *      formatter.
 *   3. Repairs the non-streaming JSON response, where Databricks-hosted
 *      Gemini returns `choices[].message.content` as a parts array that
 *      the AI SDK's OpenAI schema rejects (see
 *      {@link rewriteServingResponseBody}).
 *
 * Safe to call from any hot path: {@link functionModule.memoize} ensures
 * the wrapper is installed at most once per process, so subsequent
 * calls are a no-op even when {@link buildModel} fires on every agent
 * step.
 */
const setupFetchInterceptor = functionModule.memoize((): void => {
  const logger = log.logger("mastra/llm");
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input, init) => {
    const url = net.urlBuilder(input);
    if (
      !url ||
      !url.pathname.startsWith(SERVING_ENDPOINTS_PATH_PREFIX) ||
      typeof init?.body !== "string"
    ) {
      return original(input, init);
    }
    const rewritten = rewriteServingBody(init.body);
    if (rewritten !== init.body) {
      init = { ...init, body: rewritten };
    }
    const parsed = json.parse<unknown>(rewritten);
    logger.debug(
      "POST",
      parsed === undefined
        ? { url: url.toString(), bodyType: "non-JSON" }
        : { url: url.toString(), body: parsed },
    );
    const response = await original(input, init);
    return repairServingResponse(response);
  }) as typeof globalThis.fetch;
});

/**
 * Rewrite a non-streaming serving response whose body needs repair, leaving
 * everything else byte-identical.
 *
 * Streaming turns are passed straight through: an SSE body must stay a live
 * stream (buffering it to a string would defeat streaming and break
 * `text/event-stream` parsing), and the delta frames already carry string
 * content, so they never hit the array-shaped `content` bug. Likewise a
 * non-JSON or error body is returned untouched, so the caller still sees the
 * original status and headers.
 */
async function repairServingResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  const rewritten = rewriteServingResponseBody(body);
  if (rewritten === body) return response;

  // `content-length` / `content-encoding` describe the ORIGINAL bytes, so they
  // are dropped: the rewritten body is a different length and already decoded.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
