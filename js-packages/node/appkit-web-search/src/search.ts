/**
 * Web search backed by the Databricks Model Serving native web-search tool.
 *
 * Unlike a scraping client, the search runs *inside* a model call: we POST the
 * query to the workspace's serving endpoint with the provider's web-search
 * tool spec attached, and the model searches the web and writes the answer.
 * {@link runWebSearch}:
 *
 *   1. Resolves a web-search-capable model INDEPENDENTLY of the calling
 *      agent's chat model (the agent may run on a model without web search).
 *      A pinned `model` (request or config) is fuzzy-matched; otherwise the
 *      configured fallback order (Gemini, then GPT) is walked to the first
 *      web-search-capable endpoint that exists. An explicit but unsupported
 *      model is a hard error, not a silent fallback.
 *   2. POSTs to the provider's REST surface (`/serving-endpoints/responses`
 *      for OpenAI, `/serving-endpoints/chat/completions` for Gemini) with the
 *      mapped tool spec, authenticated as the OBO caller.
 *   3. Returns the synthesized answer plus the cited sources, with citations
 *      silently filtered through the configured URL allow-list.
 *
 * @module
 */

import {
  ConfigurationError,
  ConnectionError,
  ExecutionError,
  getExecutionContext,
  ValidationError,
} from "@databricks/appkit";
import { invoke, resolve, serving } from "@dbx-tools/model";
import { log, object, string } from "@dbx-tools/shared-core";
import { openaiChat, openaiResponses } from "@dbx-tools/shared-model";
import { MODEL_ENV, SERVING_ENDPOINT_ENV, type ResolvedWebSearchConfig } from "./config.ts";
import { toCallSettings, webSearchExecuteDefaults } from "./defaults.ts";
import { detectWebSearchProvider, supportsWebSearch, webSearchToolSpec } from "./provider.ts";
import { executeRead } from "./runtime.ts";
import type { WebSearchCitation, WebSearchRequest, WebSearchResult } from "./schema.ts";
import { runScrapeSearch } from "./scrape.ts";

type WorkspaceClientLike = serving.WorkspaceClientLike;
const logger = log.logger("web-search/search");
const { resolveModel } = resolve;
const { listServingEndpoints } = serving;

/**
 * How deep the grounding-metadata walk descends. Gemini nests its sources a
 * handful of levels down and the shape varies by model version, so the walk
 * is generic; the bound is what keeps a pathological payload from turning it
 * into a full traversal of the response.
 */
const MAX_GROUNDING_WALK_DEPTH = 6;

/** Lowest HTTP status treated as a server-side (retryable) serving failure. */
const SERVER_ERROR_STATUS = 500;

/** Status Model Serving uses to shed load; retryable like a 5xx. */
const RATE_LIMITED_STATUS = 429;

/** Context a search needs from the caller: the OBO client + workspace host. */
export interface WebSearchContext {
  client: WorkspaceClientLike;
  host: string;
}

/**
 * Resolve the OBO workspace client + host from the active AppKit execution
 * context. Inside `agent.stream`'s `asUser(req)` scope this hits the serving
 * endpoint as the requesting user; outside a user context AppKit falls back to
 * the service principal.
 */
export async function resolveWebSearchContext(): Promise<WebSearchContext> {
  const ctx = getExecutionContext();
  const host = (await ctx.client.config.getHost()).toString();
  return { client: ctx.client, host };
}

/**
 * Resolve a web-search-capable model against the LIVE workspace catalogue - so
 * we never return an endpoint id that isn't actually deployed (the "endpoint
 * does not exist" failure a hardcoded fallback id would cause). Reuses
 * `@dbx-tools/model`'s existing catalogue + resolver rather than a custom
 * lookup: {@link listServingEndpoints} lists the endpoints (cached), and we
 * restrict the candidate set to the {@link supportsWebSearch} ones before
 * {@link resolveModel} fuzzy-picks within it.
 *
 * Returns the chosen endpoint id, or `null` when the workspace has no
 * web-search-capable model deployed (the caller then uses the scrape
 * fallback). A pin the caller chose deliberately - the request's `model`, the
 * plugin's `model`, or `WEB_SEARCH_MODEL` - throws when it resolves to an
 * unsupported / absent endpoint, so a bad pin surfaces rather than silently
 * degrading. A pin inherited from the shared `DATABRICKS_SERVING_ENDPOINT_NAME`
 * binding is only a preference: that endpoint is the app's serving endpoint,
 * not necessarily a web-search-capable one, so an unusable value falls through
 * to the fallback order.
 */
async function resolveWebSearchModel(
  ctx: WebSearchContext,
  config: ResolvedWebSearchConfig,
  requested: string | undefined,
): Promise<string | null> {
  const endpoints = await listServingEndpoints(ctx.client, ctx.host);
  // Only deployed, web-search-capable endpoints are candidates.
  const capable = endpoints.filter((e) => supportsWebSearch(e.name));
  const pinned = requested ?? config.model;
  const pinIsDeliberate =
    requested !== undefined || config.modelSource === "config" || config.modelSource === MODEL_ENV;

  if (pinned) {
    // Resolve the explicit ask within the capable set only.
    const { modelId } = resolveModel(capable, {
      explicit: pinned,
      fuzzy: config.fuzzy,
      threshold: config.fuzzyThreshold,
    });
    // resolveModel returns the input verbatim on no match; require it to be a
    // real capable endpoint so a bad pin is a clear error, not a phantom call.
    const usable = capable.some((e) => e.name === modelId) && supportsWebSearch(modelId);
    if (usable) return modelId;
    const deployed = capable.map((e) => e.name).join(", ") || "none";
    if (!pinIsDeliberate) {
      logger.info("shared-endpoint-not-web-capable", {
        envVar: SERVING_ENDPOINT_ENV,
        deployed,
      });
    } else if (requested !== undefined) {
      throw ValidationError.invalidValue(
        "model",
        pinned,
        `a deployed web-search-capable endpoint (deployed: ${deployed})`,
      );
    } else {
      throw ConfigurationError.resourceNotFound(
        "Web-search-capable serving endpoint",
        `Deployed web-search-capable endpoints: ${deployed}. Set model or ${MODEL_ENV} to one of them.`,
      );
    }
  }

  if (capable.length === 0) return null;

  // Nothing usable pinned: prefer the configured fallback order (Gemini, then
  // GPT) when those ids are actually deployed; else take the best capable
  // endpoint.
  const { modelId } = resolveModel(capable, {
    fallbacks: config.modelFallbacks,
    fuzzy: config.fuzzy,
    threshold: config.fuzzyThreshold,
  });
  return capable.some((e) => e.name === modelId) ? modelId : (capable[0]?.name ?? null);
}

/**
 * POST a serving request as the OBO caller and return the parsed JSON body.
 *
 * Auth headers are minted per call from the OBO client's SDK config, which
 * refreshes the token when it is close to expiry, so the request carries the
 * requesting user's identity.
 *
 * This is the one Databricks call in the repo that does not go through
 * `apiClient.request` + `databricks.toContext` (which does forward
 * cancellation). Retry classification here has to distinguish a load-shed or
 * server fault from this request's own 4xx, and `fetch` exposes the HTTP status
 * directly; the SDK raises an `ApiError` that carries the status under
 * inconsistent keys, which is guesswork by comparison.
 */
async function postServing(
  ctx: WebSearchContext,
  url: string,
  body: unknown,
  config: ResolvedWebSearchConfig,
  cacheKey: readonly (string | number)[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = await executeRead(
    "serving-request",
    toCallSettings(webSearchExecuteDefaults, config.timeoutMs, cacheKey),
    async (executeSignal): Promise<unknown> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...(await invoke.authHeaders(ctx.client)),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      if (!response.ok) {
        // Load-shedding and server faults are worth another attempt; a 4xx is
        // this request's own problem, so it must not be retried.
        const retryable =
          response.status >= SERVER_ERROR_STATUS || response.status === RATE_LIMITED_STATUS;
        const message = `web-search: Model Serving rejected the search request (HTTP ${response.status})`;
        throw retryable
          ? new ConnectionError(message, { context: { status: response.status } })
          : new ExecutionError(message, { context: { status: response.status } });
      }
      return response.json();
    },
    signal,
  );
  return object.isRecord(payload) ? payload : {};
}

/* --------------------------- response extraction --------------------------- */

/**
 * Extract answer text + citations from an OpenAI Responses API payload, via the
 * shared reader in `@dbx-tools/shared-model` (the same module the model-proxy
 * uses to translate the Responses wire format in the other direction).
 */
function fromResponsesPayload(payload: Record<string, unknown>): {
  answer: string;
  citations: WebSearchCitation[];
} {
  const { text, citations } = openaiResponses.readResponsesOutput(payload);
  return { answer: text, citations };
}

/**
 * Extract answer text + citations from a Chat Completions payload (Gemini via
 * `google_search`). The answer is `choices[0].message.content`; grounding
 * sources, when present, surface under `choices[0].message` grounding
 * metadata (best-effort - shapes vary, so we scan for url-bearing entries).
 */
function fromChatPayload(payload: Record<string, unknown>): {
  answer: string;
  citations: WebSearchCitation[];
} {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  const message = object.isRecord(first) && object.isRecord(first.message) ? first.message : {};
  const answer = openaiChat.chatContentToText(message.content);
  const citations: WebSearchCitation[] = [];
  // Best-effort grounding extraction: walk any nested object for {uri|url,title}.
  const seen = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > MAX_GROUNDING_WALK_DEPTH || !object.isRecord(v)) return;
    const url = string.trimToEmpty(v.url) || string.trimToEmpty(v.uri);
    if (url && !seen.has(url)) {
      seen.add(url);
      const title = string.trimToEmpty(v.title);
      citations.push({ url, ...(title ? { title } : {}) });
    }
    for (const val of Object.values(v)) {
      if (Array.isArray(val)) val.forEach((x) => visit(x, depth + 1));
      else if (val && typeof val === "object") visit(val, depth + 1);
    }
  };
  visit(message.grounding_metadata ?? message.groundingMetadata, 0);
  return { answer, citations };
}

/**
 * Run a web search. Prefers the Databricks native web-search tool on a
 * deployed GPT/Gemini endpoint (synthesized answer + citations); when the
 * workspace has no such endpoint AND the scrape fallback is enabled, falls
 * back to a DuckDuckGo scrape so the tool still returns results instead of
 * erroring. Citations are filtered through the configured URL allow-list.
 *
 * `signal` cancels the whole call, including the in-flight serving request.
 */
export async function runWebSearch(
  request: WebSearchRequest,
  config: ResolvedWebSearchConfig,
  ctx: WebSearchContext,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  const modelId = await resolveWebSearchModel(ctx, config, request.model);

  if (modelId === null) {
    // No native web-search model deployed in this workspace.
    if (config.scrapeFallback) {
      logger.info("no-native-model:scrape-fallback", { query: request.query });
      return runScrapeSearch(request, config, signal);
    }
    throw ConfigurationError.resourceNotFound(
      "Web-search-capable serving endpoint",
      "No GPT/Gemini endpoint is deployed in this workspace and the scrape fallback is " +
        `disabled. Deploy a supported endpoint, set model or ${MODEL_ENV}, or enable the ` +
        "fallback (WEB_SEARCH_SCRAPE_FALLBACK=1).",
    );
  }

  const provider = detectWebSearchProvider(modelId)!; // guaranteed by resolve step
  const spec = webSearchToolSpec(provider, config.webSearchTools);

  const url =
    spec.api === "responses" ? invoke.responsesUrl(ctx.host) : invoke.chatCompletionsUrl(ctx.host);
  const body =
    spec.api === "responses"
      ? {
          model: modelId,
          input: [{ role: "user", content: request.query }],
          tools: [spec.tool],
        }
      : {
          model: modelId,
          messages: [{ role: "user", content: request.query }],
          tools: [spec.tool],
        };

  const payload = await postServing(
    ctx,
    url,
    body,
    config,
    ["web-search", "serving", spec.api, modelId, request.query],
    signal,
  );

  const { answer, citations } =
    spec.api === "responses" ? fromResponsesPayload(payload) : fromChatPayload(payload);

  const permitted = citations.filter((c) => config.allowList.allows(c.url));
  const dropped = citations.length - permitted.length;
  const trimmed = permitted.slice(0, config.maxCitations);
  logger.debug("searched", {
    query: request.query,
    model: modelId,
    provider,
    citations: citations.length,
    ...(dropped > 0 ? { filtered: dropped } : {}),
    returned: trimmed.length,
  });

  return { query: request.query, answer, citations: trimmed, model: modelId };
}
