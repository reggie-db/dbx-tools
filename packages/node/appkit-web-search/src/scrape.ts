/**
 * Last-resort scraping fallback for `web_search`, used ONLY when the
 * workspace has no Databricks web-search-capable model deployed (no GPT /
 * Gemini serving endpoint). The native Databricks web-search tool is always
 * preferred (see `search.ts`); this exists so the tool still returns useful
 * results in an environment that can't run it, rather than erroring on every
 * call.
 *
 * It queries DuckDuckGo's no-JS HTML endpoint through `got-scraping`
 * (browser-like fingerprints so the request isn't blocked) via a GET with the
 * query in the query string - a POST to the same endpoint trips DDG's bot
 * challenge (HTTP 202), while the GET returns normal result markup. It then
 * parses the result anchors + snippets. Unlike the native tool there is no
 * model synthesizing an answer, so `answer` is a short lead-in over the top
 * snippets and the substance rides in `citations` - the calling agent reads
 * those and writes its own answer.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import { gotScraping } from "got-scraping";
import type { ResolvedWebSearchConfig } from "./config";
import { scrapeSearchExecuteDefaults, toCallSettings } from "./defaults";
import { htmlFragmentToText } from "./html-text";
import { executeRead } from "./runtime";
import type { WebSearchCitation, WebSearchRequest, WebSearchResult } from "./schema";

const logger = log.logger("web-search/scrape");

/** DuckDuckGo's no-JS HTML results endpoint (queried via GET). */
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

/**
 * DDG wraps result URLs in a redirect (`//duckduckgo.com/l/?uddg=<encoded>`).
 * Unwrap to the real destination; leave already-absolute URLs untouched.
 */
function unwrapDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : href;
  } catch {
    return href;
  }
}

/** Parse DDG HTML result blocks into citations (title, url, snippet). */
function parseDdgHtml(html: string): WebSearchCitation[] {
  const citations: WebSearchCitation[] = [];
  // Each result: an anchor with class result__a (title + href) and a snippet
  // with class result__snippet. Match anchors, then the following snippet.
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(htmlFragmentToText(sm[1] ?? ""));
  let am: RegExpExecArray | null;
  let i = 0;
  while ((am = anchorRe.exec(html)) !== null) {
    const url = unwrapDdgUrl(am[1] ?? "");
    const title = htmlFragmentToText(am[2] ?? "");
    if (!url || !title) continue;
    const snippet = snippets[i] ?? "";
    citations.push({ url, title, ...(snippet ? { snippet } : {}) });
    i += 1;
  }
  return citations;
}

/**
 * Run a scraping search over DuckDuckGo. Returns the same
 * {@link WebSearchResult} shape as the native path, with `model` set to
 * `"scrape:duckduckgo"` so callers can tell how the result was produced.
 * Citations are filtered through the configured URL allow-list. `signal`
 * cancels the in-flight request.
 */
export async function runScrapeSearch(
  request: WebSearchRequest,
  config: ResolvedWebSearchConfig,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  const page = await executeRead(
    "scrape-search",
    toCallSettings(scrapeSearchExecuteDefaults, config.timeoutMs, [
      "web-search",
      "scrape",
      request.query,
    ]),
    async (executeSignal): Promise<{ body: string; statusCode: number }> => {
      const response = await gotScraping({
        url: `${DDG_HTML_URL}?q=${encodeURIComponent(request.query)}`,
        method: "GET",
        // got's own timeout aborts the socket and reports which phase timed
        // out; the interceptor timeout bounds the whole attempt around it.
        timeout: { request: config.timeoutMs },
        throwHttpErrors: false,
        followRedirect: true,
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      return {
        body: typeof response.body === "string" ? response.body : String(response.body ?? ""),
        statusCode: response.statusCode,
      };
    },
    signal,
  );
  const all = parseDdgHtml(page.body);
  const permitted = all.filter((c) => config.allowList.allows(c.url));
  const citations = permitted.slice(0, config.maxCitations);
  const answer =
    citations.length > 0
      ? `Web results for "${request.query}" (no Databricks web-search model is deployed in this workspace, so these are unsynthesized search results - read the citations):\n\n` +
        citations
          .map((c, n) => `${n + 1}. ${c.title}${c.snippet ? ` - ${c.snippet}` : ""} (${c.url})`)
          .join("\n")
      : `No web results found for "${request.query}".`;
  logger.debug("scraped", {
    query: request.query,
    found: all.length,
    returned: citations.length,
    status: page.statusCode,
  });
  return { query: request.query, answer, citations, model: "scrape:duckduckgo" };
}
