/**
 * Metasearch over {@link https://www.npmjs.com/package/duck-duck-scrape | duck-duck-scrape}
 * - the Node counterpart to the Python `ddgs` library: it scrapes DuckDuckGo's
 * public endpoints (no API key) and returns `{ title, url, description,
 * hostname }` rows. {@link runWebSearch} normalizes those into the add-on's
 * {@link WebSearchResult} shape, maps our friendly {@link SafeSearch} enum onto
 * the library's numeric one, applies the plugin's result cap, and silently
 * filters the hits through the configured URL allow-list.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import { SafeSearchType, search, searchNews } from "duck-duck-scrape";
import type { ResolvedWebSearchConfig } from "./config";
import type { SafeSearch, WebSearchRequest, WebSearchResult, WebSearchResultItem } from "./schema";

const logger = log.logger("web-search/search");

/** Map the friendly enum onto duck-duck-scrape's numeric `SafeSearchType`. */
function toSafeSearchType(safeSearch: SafeSearch): SafeSearchType {
  switch (safeSearch) {
    case "strict":
      return SafeSearchType.STRICT;
    case "off":
      return SafeSearchType.OFF;
    default:
      return SafeSearchType.MODERATE;
  }
}

/** Derive a hostname from a result URL, falling back to a supplied value. */
function hostnameOf(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

/**
 * Run a web search and return normalized, allow-list-filtered results.
 *
 * The request's `safeSearch` / `region` / `maxResults` override the plugin
 * defaults when present; the plugin's `maxResults` is always an upper bound.
 * When the allow-list is restricted, disallowed URLs are dropped BEFORE the
 * cap is applied, so a filtered search still returns up to `maxResults`
 * permitted hits when they exist.
 */
export async function runWebSearch(
  request: WebSearchRequest,
  config: ResolvedWebSearchConfig,
): Promise<WebSearchResult> {
  const safeSearch = toSafeSearchType(request.safeSearch ?? config.safeSearch);
  const region = request.region ?? config.region;
  const cap = Math.min(request.maxResults ?? config.maxResults, config.maxResults);
  const needleOptions = { open_timeout: config.timeoutMs, response_timeout: config.timeoutMs };

  const rawResults: WebSearchResultItem[] = [];
  if (request.backend === "news") {
    const response = await searchNews(request.query, { safeSearch }, needleOptions);
    for (const item of response.results ?? []) {
      rawResults.push({
        title: item.title,
        url: item.url,
        snippet: item.excerpt ?? "",
        hostname: hostnameOf(item.url, item.syndicate ?? ""),
      });
    }
  } else {
    const response = await search(request.query, { safeSearch, region }, needleOptions);
    for (const item of response.results ?? []) {
      rawResults.push({
        title: item.title,
        url: item.url,
        snippet: item.description ?? "",
        hostname: item.hostname ?? hostnameOf(item.url, ""),
      });
    }
  }

  const permitted = rawResults.filter((item) => config.allowList.allows(item.url));
  const dropped = rawResults.length - permitted.length;
  const results = permitted.slice(0, cap);
  logger.debug("searched", {
    query: request.query,
    backend: request.backend ?? "text",
    found: rawResults.length,
    ...(dropped > 0 ? { filtered: dropped } : {}),
    returned: results.length,
  });
  return { query: request.query, results };
}
