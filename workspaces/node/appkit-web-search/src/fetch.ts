/**
 * Page fetching over {@link https://www.npmjs.com/package/got-scraping | got-scraping}
 * - a `got` wrapper that generates browser-like TLS + header fingerprints, so
 * fetches survive the bot walls a plain `fetch` trips. {@link runWebFetch}
 * enforces the URL allow-list (an explicit fetch of a disallowed URL is
 * refused, not silently emptied), fetches with the plugin's timeout, and
 * returns either the raw HTML or a readable plain-text reduction, capped at
 * the configured length.
 *
 * The HTML-to-text reduction is deliberately dependency-free (strip
 * script/style, unwrap tags, decode a handful of entities, collapse
 * whitespace): good enough to feed a model, and it keeps the add-on's
 * dependency surface to the two libraries the task called for.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import { gotScraping } from "got-scraping";
import { assertUrlAllowed } from "./allowlist";
import { decodeHtmlEntities, htmlToText } from "./html-text";
import type { ResolvedWebSearchConfig } from "./config";
import type { WebFetchRequest, WebFetchResult } from "./schema";

const logger = log.logger("web-search/fetch");

/** Pull the <title> text out of an HTML document, when present. */
function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeHtmlEntities(match[1]).trim() : "";
  return title.length > 0 ? title : undefined;
}

/** Truncate `text` to `max` chars, reporting whether it was cut. */
function truncate(text: string, max: number): { content: string; truncated: boolean } {
  if (text.length <= max) return { content: text, truncated: false };
  return { content: text.slice(0, max), truncated: true };
}

/**
 * Fetch a single URL and return its content in the requested format.
 *
 * Throws when the URL is not permitted by the allow-list (the visible,
 * correctable failure the design calls for on the fetch path). Network /
 * HTTP errors propagate from got-scraping. The request's `maxLength` narrows
 * (never widens) the plugin's `fetchMaxLength` cap.
 */
export async function runWebFetch(
  request: WebFetchRequest,
  config: ResolvedWebSearchConfig,
): Promise<WebFetchResult> {
  assertUrlAllowed(request.url, config.allowList);
  const cap = Math.min(request.maxLength ?? config.fetchMaxLength, config.fetchMaxLength);

  const response = await gotScraping({
    url: request.url,
    timeout: { request: config.timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
  });

  const body = typeof response.body === "string" ? response.body : String(response.body ?? "");
  const contentType = response.headers["content-type"];
  const isHtml = !contentType || /html|xml/i.test(contentType);
  const rawContent = request.format === "html" || !isHtml ? body : htmlToText(body);
  const { content, truncated } = truncate(rawContent, cap);
  const title = isHtml ? extractTitle(body) : undefined;

  logger.debug("fetched", {
    url: response.url,
    status: response.statusCode,
    bytes: body.length,
    returned: content.length,
    ...(truncated ? { truncated: true } : {}),
  });

  return {
    url: response.url ?? request.url,
    status: response.statusCode,
    ...(contentType ? { contentType } : {}),
    ...(title ? { title } : {}),
    content,
    truncated,
  };
}
