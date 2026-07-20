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
import type { ResolvedWebSearchConfig } from "./config";
import type { WebFetchRequest, WebFetchResult } from "./schema";

const logger = log.logger("web-search/fetch");

/** Pull the <title> text out of an HTML document, when present. */
function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).trim() : "";
  return title.length > 0 ? title : undefined;
}

/** Decode the handful of HTML entities that survive tag-stripping. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * Reduce an HTML document to readable plain text: drop `<script>` /
 * `<style>` / `<noscript>` blocks and HTML comments, turn block-level tags
 * into newlines, strip the remaining tags, decode entities, and collapse
 * runs of blank lines / trailing spaces.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
  const rawContent =
    request.format === "html" || !isHtml ? body : htmlToText(body);
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
