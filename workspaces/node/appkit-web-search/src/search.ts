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
 *      web-search-capable endpoint that exists in the workspace. An explicit
 *      but unsupported model is a hard error, not a silent fallback.
 *   2. POSTs to the provider's REST surface (`/serving-endpoints/responses`
 *      for OpenAI, `/serving-endpoints/chat/completions` for Gemini) with the
 *      mapped tool spec, using the OBO-scoped workspace client.
 *   3. Returns the synthesized answer plus the cited sources, with citations
 *      silently filtered through the configured URL allow-list.
 *
 * @module
 */

import { error, log } from "@dbx-tools/shared-core";
import { resolve, type serving } from "@dbx-tools/model";

type WorkspaceClientLike = serving.WorkspaceClientLike;
import type { ResolvedWebSearchConfig } from "./config";
import { detectWebSearchProvider, supportsWebSearch, webSearchToolSpec } from "./provider";
import type { WebSearchCitation, WebSearchRequest, WebSearchResult } from "./schema";

const logger = log.logger("web-search/search");
const { selectModel } = resolve;

/** Context a search needs from the caller: the OBO client + workspace host. */
export interface WebSearchContext {
  client: WorkspaceClientLike;
  host: string;
}

/**
 * Resolve the web-search model for this call. A pinned id (request wins over
 * config) is fuzzy-matched against the catalogue; if the result isn't
 * web-search-capable AND the id was explicitly asked for, throw. With nothing
 * pinned, walk the fallback order (each fuzzy-matched) and take the first
 * web-search-capable endpoint. Returns the resolved endpoint id.
 */
async function resolveWebSearchModel(
  ctx: WebSearchContext,
  config: ResolvedWebSearchConfig,
  requested: string | undefined,
): Promise<string> {
  const fuzzy = config.fuzzy;
  const threshold = config.fuzzyThreshold;

  const pinned = requested ?? config.model;
  if (pinned) {
    const { modelId } = await selectModel(ctx.client, ctx.host, {
      explicit: pinned,
      fuzzy,
      threshold,
    });
    if (!supportsWebSearch(modelId)) {
      throw new Error(
        `web-search: model "${modelId}" (resolved from "${pinned}") does not support web search - ` +
          `use a GPT or Gemini serving endpoint (e.g. databricks-gemini-3-pro, databricks-gpt-5).`,
      );
    }
    return modelId;
  }

  // Nothing pinned: walk the fallback order and take the first supported one.
  for (const candidate of config.modelFallbacks) {
    const { modelId } = await selectModel(ctx.client, ctx.host, {
      explicit: candidate,
      fuzzy,
      threshold,
    });
    if (supportsWebSearch(modelId)) return modelId;
  }
  throw new Error(
    `web-search: no web-search-capable model found among fallbacks [${config.modelFallbacks.join(", ")}] - ` +
      `set \`model\` / WEB_SEARCH_MODEL to a GPT or Gemini endpoint.`,
  );
}

/** POST a serving request through the OBO client and return the parsed JSON. */
async function postServing(
  ctx: WebSearchContext,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await ctx.client.apiClient.request({
    path,
    method: "POST",
    headers: new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
    raw: false,
    payload: body,
  });
  return (res ?? {}) as Record<string, unknown>;
}

/* --------------------------- response extraction --------------------------- */

/** Coerce an unknown to a trimmed string, or "" . */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Extract answer text + citations from an OpenAI Responses API payload. The
 * Responses API returns an `output` array of items; message items carry
 * `content` parts with `text` and optional `annotations` (url_citation).
 * `output_text` is the convenience aggregate when present.
 */
function fromResponsesPayload(payload: Record<string, unknown>): {
  answer: string;
  citations: WebSearchCitation[];
} {
  const citations: WebSearchCitation[] = [];
  const texts: string[] = [];
  const output = Array.isArray(payload["output"]) ? (payload["output"] as unknown[]) : [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { text?: unknown; annotations?: unknown };
      const text = str(p.text);
      if (text) texts.push(text);
      if (Array.isArray(p.annotations)) {
        for (const ann of p.annotations) {
          const a = ann as { url?: unknown; title?: unknown };
          const url = str(a.url);
          if (url) citations.push({ url, ...(str(a.title) ? { title: str(a.title) } : {}) });
        }
      }
    }
  }
  const answer = str(payload["output_text"]) || texts.join("\n").trim();
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
  const choices = Array.isArray(payload["choices"]) ? (payload["choices"] as unknown[]) : [];
  const message = (choices[0] as { message?: Record<string, unknown> })?.message ?? {};
  const answer = str(message["content"]);
  const citations: WebSearchCitation[] = [];
  // Best-effort grounding extraction: walk any nested object for {uri|url,title}.
  const seen = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const url = str(o["url"]) || str(o["uri"]);
    if (url && !seen.has(url)) {
      seen.add(url);
      citations.push({ url, ...(str(o["title"]) ? { title: str(o["title"]) } : {}) });
    }
    for (const val of Object.values(o)) {
      if (Array.isArray(val)) val.forEach((x) => visit(x, depth + 1));
      else if (val && typeof val === "object") visit(val, depth + 1);
    }
  };
  visit(message["grounding_metadata"] ?? message["groundingMetadata"], 0);
  return { answer, citations };
}

/**
 * Run a web search via the Databricks native web-search tool and return the
 * synthesized answer plus allow-list-filtered citations.
 */
export async function runWebSearch(
  request: WebSearchRequest,
  config: ResolvedWebSearchConfig,
  ctx: WebSearchContext,
): Promise<WebSearchResult> {
  const modelId = await resolveWebSearchModel(ctx, config, request.model);
  const provider = detectWebSearchProvider(modelId)!; // guaranteed by resolve step
  const spec = webSearchToolSpec(provider, config.webSearchTools);

  const path =
    spec.api === "responses"
      ? "/serving-endpoints/responses"
      : "/serving-endpoints/chat/completions";
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

  let payload: Record<string, unknown>;
  try {
    payload = await postServing(ctx, path, body);
  } catch (err) {
    logger.warn("serving-error", { model: modelId, provider, error: error.errorMessage(err) });
    throw err;
  }

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
