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
} from "@databricks/appkit";
import type { AgentToolExecutionContext } from "@dbx-tools/appkit/tool-provider";
import { invoke, policy, resolve, modelCatalog } from "@dbx-tools/model";
import { log, object, stringUtils } from "@dbx-tools/shared-core";
import { openaiChat, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import { MODEL_ENV, type ResolvedWebSearchConfig } from "./config.ts";
import { toCallSettings, webSearchExecuteDefaults } from "./defaults.ts";
import { supportsWebSearch, webSearchProviderForFamily, webSearchToolSpec } from "./provider.ts";
import {
  executeRead,
  toWebSearchRuntime,
  type WebSearchRuntime,
  type WebSearchRuntimeInput,
} from "./runtime.ts";
import type { WebSearchCitation, WebSearchRequest, WebSearchResult } from "./schema.ts";
import { runScrapeSearch } from "./scrape.ts";

type WorkspaceClientLike = modelCatalog.WorkspaceClientLike & invoke.AuthenticatingClientLike;
type ProgressWriter = NonNullable<AgentToolExecutionContext["writeProgress"]>;
const logger = log.logger("web-search/search");
const { lookupModels } = resolve;
const { listServingEndpoints } = modelCatalog;

/**
 * How deep the grounding-metadata walk descends. Gemini nests its sources a
 * handful of levels down and the shape varies by model version, so the walk
 * is generic; the bound is what keeps a pathological payload from turning it
 * into a full traversal of the response.
 */
const MAX_GROUNDING_WALK_DEPTH = 6;
const GEMINI_CROSS_REGION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GEMINI_CROSS_REGION_DISABLED = /cross-region processing is disabled/i;

/** Lowest HTTP status treated as a server-side (retryable) serving failure. */
const SERVER_ERROR_STATUS = 500;

/** Status Model Serving uses to shed load; retryable like a 5xx. */
const RATE_LIMITED_STATUS = 429;

/** Context a search needs from the caller: the OBO client + workspace host. */
export interface WebSearchContext {
  client: WorkspaceClientLike;
  host: string;
  /** Trusted identity of the credential carried by `client`. */
  cacheIdentity?: string;
}

/** Model-selection fields used to rank one web-search endpoint. */
export type WebSearchModelSelectionOptions = Pick<
  ResolvedWebSearchConfig,
  "model" | "modelFallbacks" | "fuzzy" | "fuzzyThreshold"
>;

/**
 * Resolve the OBO workspace client + host from the active AppKit execution
 * context. Inside `agent.stream`'s `asUser(req)` scope this hits the serving
 * endpoint as the requesting user; outside a user context AppKit falls back to
 * the service principal.
 */
export async function resolveWebSearchContext(): Promise<WebSearchContext> {
  const ctx = getExecutionContext();
  const host = (await ctx.client.config.getHost()).toString();
  const cacheIdentity = "userId" in ctx ? ctx.userId : ctx.serviceUserId;
  return { client: ctx.client, host, cacheIdentity };
}

/**
 * Resolve a web-search-capable model against the LIVE workspace catalogue - so
 * we never return an endpoint id that isn't actually deployed (the "endpoint
 * does not exist" failure a hardcoded fallback id would cause). Reuses
 * `@dbx-tools/model`'s existing catalogue + ranker rather than a custom
 * lookup: {@link listServingEndpoints} lists the endpoints (cached), and we
 * restrict the candidate set through model-owned capability metadata before
 * {@link lookupModels} ranks within it.
 *
 * The highest-ranked Gemini model wins. Without Gemini, a GPT request matching
 * the calling/configured model wins, followed by the highest-ranked GPT model
 * and then any additional configured searches.
 */
async function resolveWebSearchModel(
  ctx: WebSearchContext,
  runtime: WebSearchRuntime,
  requested: string | undefined,
): Promise<ServingEndpointSummary | null> {
  const { config } = runtime;
  const endpoints = await listServingEndpoints(ctx.client, ctx.host, {
    ...(ctx.cacheIdentity ? { cacheIdentity: ctx.cacheIdentity } : {}),
  });
  return selectWebSearchEndpoint(endpoints, requested, config, activeFamilyCooldowns(runtime));
}

/** Select one deployed web-search endpoint using family and capability policy. */
export function selectWebSearchEndpoint(
  endpoints: readonly ServingEndpointSummary[],
  requested: string | undefined,
  config: WebSearchModelSelectionOptions,
  suppressedFamilies: ReadonlySet<policy.ModelFamily> = new Set(),
): ServingEndpointSummary | null {
  // Only deployed, web-search-capable endpoints are candidates.
  const capable = endpoints.filter((endpoint) => {
    const family = endpointFamily(endpoint);
    return supportsWebSearch(endpoint) && (!family || !suppressedFamilies.has(family));
  });
  const gemini = lookupModels(capable, {
    search: policy.ModelFamily.Gemini,
    limit: 1,
    threshold: config.fuzzyThreshold,
  })[0]?.endpoint;
  if (gemini) return gemini;
  const gpt = lookupModels(capable, {
    search: policy.ModelFamily.Gpt,
    limit: 50,
    threshold: config.fuzzyThreshold,
  }).map(({ endpoint }) => endpoint);

  const preferred = requested ?? config.model;
  if (preferred && policy.modelFamily(preferred) === policy.ModelFamily.Gpt) {
    const matched = config.fuzzy
      ? lookupModels(gpt, {
          search: preferred,
          limit: 1,
          threshold: config.fuzzyThreshold,
        })[0]?.endpoint
      : gpt.find((endpoint) => endpoint.name === preferred);
    if (matched) return matched;
  }
  if (gpt[0]) return gpt[0];

  for (const search of config.modelFallbacks) {
    if (
      search.toLowerCase() === policy.ModelFamily.Gemini ||
      search.toLowerCase() === policy.ModelFamily.Gpt
    ) {
      continue;
    }
    const matched = lookupModels(capable, {
      search,
      limit: 1,
      threshold: config.fuzzyThreshold,
    })[0]?.endpoint;
    if (matched) return matched;
  }

  return null;
}

/** Return one endpoint's model-owned family identity. */
function endpointFamily(endpoint: ServingEndpointSummary): policy.ModelFamily | undefined {
  return policy.modelFamily(endpoint.modelServiceName ?? endpoint.name);
}

/** Drop expired family cooldowns and return the currently suppressed set. */
function activeFamilyCooldowns(
  runtime: WebSearchRuntime,
  now = Date.now(),
): ReadonlySet<policy.ModelFamily> {
  for (const [family, expiresAt] of runtime.familyCooldowns) {
    if (expiresAt <= now) runtime.familyCooldowns.delete(family);
  }
  return new Set(runtime.familyCooldowns.keys());
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
  runtime: WebSearchRuntime,
  cacheKey: readonly (string | number)[],
  signal?: AbortSignal,
  writeProgress?: ProgressWriter,
): Promise<Record<string, unknown>> {
  const { config } = runtime;
  const payload = await executeRead(
    runtime,
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
        const responseBody = await response.text();
        const model =
          object.isRecord(body) && typeof body.model === "string" ? body.model : undefined;
        logger.error("serving-request-rejected", {
          model,
          api: url.endsWith("/responses") ? "responses" : "chat",
          url,
          status: response.status,
          responseBody,
        });
        if (
          response.status === 400 &&
          model &&
          policy.modelFamily(model) === policy.ModelFamily.Gemini &&
          GEMINI_CROSS_REGION_DISABLED.test(responseBody)
        ) {
          const expiresAt = Date.now() + GEMINI_CROSS_REGION_COOLDOWN_MS;
          runtime.familyCooldowns.set(policy.ModelFamily.Gemini, expiresAt);
          logger.warn("provider-family-suppressed", {
            family: policy.ModelFamily.Gemini,
            reason: "cross-region-disabled",
            expiresAt: new Date(expiresAt).toISOString(),
          });
        }
        // Load-shedding and server faults are worth another attempt; a 4xx is
        // this request's own problem, so it must not be retried.
        const retryable =
          response.status >= SERVER_ERROR_STATUS || response.status === RATE_LIMITED_STATUS;
        const message = `web-search: Model Serving rejected the search request (HTTP ${response.status})`;
        throw retryable
          ? new ConnectionError(message, { context: { status: response.status } })
          : new ExecutionError(message, { context: { status: response.status } });
      }
      return writeProgress &&
        response.body &&
        response.headers.get("content-type")?.includes("text/event-stream")
        ? readStreamingResponse(response, writeProgress)
        : response.json();
    },
    signal,
  );
  return object.isRecord(payload) ? payload : {};
}

/** Consume an OpenAI Responses SSE stream and retain its completed response. */
async function readStreamingResponse(
  response: Response,
  writeProgress: ProgressWriter,
): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | undefined;
  const consume = async (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as unknown;
    if (!object.isRecord(event) || typeof event.type !== "string") return;
    await emitWebSearchProgress(event, writeProgress);
    if (event.type === "response.completed" && object.isRecord(event.response)) {
      completed = event.response;
    }
    if (event.type === "response.failed") {
      throw new ExecutionError("web-search: streaming response failed", {
        context: { response: event.response },
      });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      await consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  if (!completed) throw new ExecutionError("web-search: streaming response did not complete");
  return completed;
}

/** Publish native web-search lifecycle events as common tool progress. */
async function emitWebSearchProgress(
  event: Record<string, unknown>,
  writeProgress: ProgressWriter,
): Promise<void> {
  if (event.type !== "response.output_item.done" || !object.isRecord(event.item)) return;
  const action = object.isRecord(event.item.action) ? event.item.action : undefined;
  if (!action || action.type !== "search") return;
  const query = typeof action.query === "string" ? action.query : undefined;
  const queries = Array.isArray(action.queries)
    ? action.queries.filter((value): value is string => typeof value === "string")
    : [];
  const groupId =
    typeof event.item.id === "string"
      ? event.item.id
      : `search-${String(event.sequence_number ?? query ?? "unknown")}`;
  const resultCount = queries.length > 0 ? queries.length : query ? 1 : 0;
  await writeProgress({
    type: "tool_status",
    status: "search",
    message: query ?? "the web",
    groupId,
  });
  await writeProgress({
    type: "tool_status",
    status: "result",
    message: "Result",
    groupId,
    ...(resultCount > 0
      ? { detail: `${resultCount} ${resultCount === 1 ? "result" : "results"}` }
      : {}),
  });
}

/* --------------------------- response extraction --------------------------- */

/**
 * Extract answer text and citations from an OpenAI Responses API payload.
 */
function fromResponsesPayload(payload: Record<string, unknown>): {
  answer: string;
  citations: WebSearchCitation[];
} {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];
  const citations: WebSearchCitation[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    if (!object.isRecord(item)) continue;
    const parts = openaiChat.chatContentParts(item.content);
    if (!parts) continue;
    for (const part of parts) {
      if (!object.isRecord(part)) continue;
      const text = stringUtils.trimToEmpty(part.text);
      if (text) texts.push(text);
      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (!object.isRecord(annotation)) continue;
        const url = stringUtils.trimToEmpty(annotation.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = stringUtils.trimToEmpty(annotation.title);
        citations.push({ url, ...(title ? { title } : {}) });
      }
    }
  }
  const answer = stringUtils.trimToEmpty(payload.output_text) || texts.join("\n").trim();
  return { answer, citations };
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
    const url = stringUtils.trimToEmpty(v.url) || stringUtils.trimToEmpty(v.uri);
    if (url && !seen.has(url)) {
      seen.add(url);
      const title = stringUtils.trimToEmpty(v.title);
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
  runtimeOrConfig: WebSearchRuntimeInput,
  ctx: WebSearchContext,
  signal?: AbortSignal,
  writeProgress?: ProgressWriter,
): Promise<WebSearchResult> {
  const runtime = toWebSearchRuntime(runtimeOrConfig);
  const { config } = runtime;
  const endpoint = await resolveWebSearchModel(ctx, runtime, request.model);

  if (endpoint === null) {
    // No native web-search model deployed in this workspace.
    if (config.scrapeFallback) {
      logger.info("no-native-model:scrape-fallback", { query: request.query });
      return runScrapeSearch(request, runtime, signal);
    }
    throw ConfigurationError.resourceNotFound(
      "Web-search-capable serving endpoint",
      "No GPT/Gemini endpoint is deployed in this workspace and the scrape fallback is " +
        `disabled. Deploy a supported endpoint, set model or ${MODEL_ENV}, or enable the ` +
        "fallback (WEB_SEARCH_SCRAPE_FALLBACK=1).",
    );
  }

  try {
    return await runNativeWebSearch(request, runtime, ctx, endpoint, signal, writeProgress);
  } catch (error) {
    if (
      endpointFamily(endpoint) !== policy.ModelFamily.Gemini ||
      !activeFamilyCooldowns(runtime).has(policy.ModelFamily.Gemini)
    ) {
      throw error;
    }
    const fallback = await resolveWebSearchModel(ctx, runtime, request.model);
    if (!fallback) {
      if (config.scrapeFallback) {
        logger.info("gemini-unavailable:scrape-fallback", { query: request.query });
        return runScrapeSearch(request, runtime, signal);
      }
      throw error;
    }
    logger.info("gemini-unavailable:model-fallback", {
      failedModel: endpoint.name,
      fallbackModel: fallback.name,
    });
    return runNativeWebSearch(request, runtime, ctx, fallback, signal, writeProgress);
  }
}

/** Execute one native provider request against an already-selected endpoint. */
async function runNativeWebSearch(
  request: WebSearchRequest,
  runtime: WebSearchRuntime,
  ctx: WebSearchContext,
  endpoint: ServingEndpointSummary,
  signal?: AbortSignal,
  writeProgress?: ProgressWriter,
): Promise<WebSearchResult> {
  const { config } = runtime;
  const modelId = endpoint.name;
  const provider = webSearchProviderForFamily(
    policy.modelFamily(endpoint.modelServiceName ?? endpoint.name),
  );
  if (!provider) {
    throw ConfigurationError.resourceNotFound(
      "Native web-search provider",
      `Model ${modelId} has no supported provider family.`,
    );
  }
  const spec = webSearchToolSpec(provider, config.webSearchTools);

  const url =
    spec.api === "responses" ? invoke.responsesUrl(ctx.host) : invoke.chatCompletionsUrl(ctx.host);
  const body =
    spec.api === "responses"
      ? {
          ...spec.request,
          model: modelId,
          input: [{ role: "user", content: request.query }],
          ...(writeProgress ? { stream: true } : {}),
        }
      : {
          ...spec.request,
          model: modelId,
          messages: [{ role: "user", content: request.query }],
        };

  const payload = await postServing(
    ctx,
    url,
    body,
    runtime,
    ["web-search", "serving", spec.api, modelId, request.query],
    signal,
    writeProgress,
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
