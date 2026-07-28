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
import { assertUrlAllowed } from "./allowlist.ts";
import type { ResolvedWebSearchConfig } from "./config.ts";
import { toCallSettings, webFetchExecuteDefaults } from "./defaults.ts";
import { decodeHtmlEntities, htmlToText } from "./html-text.ts";
import { executeRead } from "./runtime.ts";
import type { WebFetchRequest, WebFetchResult } from "./schema.ts";

const logger = log.logger("web-search/fetch");

/** The slice of a got-scraping response this module reads. */
interface FetchedPage {
  url: string;
  statusCode: number;
  contentType: string | undefined;
  body: string;
}

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
 * correctable failure the design calls for on the fetch path). The request's
 * `maxLength` narrows (never widens) the plugin's `fetchMaxLength` cap.
 * `signal` cancels the in-flight fetch.
 */
export async function runWebFetch(
  request: WebFetchRequest,
  config: ResolvedWebSearchConfig,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  assertUrlAllowed(request.url, config.allowList);
  const cap = Math.min(request.maxLength ?? config.fetchMaxLength, config.fetchMaxLength);

  // The response is cached before the format reduction, so the same page read
  // as text and as html shares one network round trip.
  const page = await executeRead(
    "page-fetch",
    toCallSettings(webFetchExecuteDefaults, config.timeoutMs, ["web-search", "fetch", request.url]),
    async (executeSignal): Promise<FetchedPage> => {
      const response = await gotScraping({
        url: request.url,
        // got's own timeout aborts the socket and reports which phase timed
        // out; the interceptor timeout bounds the whole attempt around it.
        timeout: { request: config.timeoutMs },
        throwHttpErrors: false,
        followRedirect: true,
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      return {
        url: response.url ?? request.url,
        statusCode: response.statusCode,
        contentType: response.headers["content-type"],
        body: typeof response.body === "string" ? response.body : String(response.body ?? ""),
      };
    },
    signal,
  );

  const isHtml = !page.contentType || /html|xml/i.test(page.contentType);
  const rawContent = request.format === "html" || !isHtml ? page.body : htmlToText(page.body);
  const { content, truncated } = truncate(rawContent, cap);
  const title = isHtml ? extractTitle(page.body) : undefined;

  logger.debug("fetched", {
    url: page.url,
    status: page.statusCode,
    bytes: page.body.length,
    returned: content.length,
    ...(truncated ? { truncated: true } : {}),
  });

  return {
    url: page.url,
    status: page.statusCode,
    ...(page.contentType ? { contentType: page.contentType } : {}),
    ...(title ? { title } : {}),
    content,
    truncated,
  };
}
