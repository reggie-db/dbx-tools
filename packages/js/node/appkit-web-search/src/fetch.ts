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
import { assertFetchUrlAllowed } from "./_fetch-url.ts";
import { toCallSettings, webFetchExecuteDefaults } from "./defaults.ts";
import { decodeHtmlEntities, htmlToText } from "./html-text.ts";
import {
  executeRead,
  toWebSearchRuntime,
  type WebSearchRuntime,
  type WebSearchRuntimeInput,
} from "./runtime.ts";
import type { WebFetchRequest, WebFetchResult } from "./schema.ts";

const logger = log.logger("web-search/fetch");
const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ASSET_PAGE_MAX_LENGTH = 1_500_000;

/** Input for a policy-checked HTML fetch used by in-process asset discovery. */
export interface WebAssetPageFetchRequest {
  /** Public HTTPS page URL. */
  url: string;
  /** Maximum returned markup length. Defaults to 1.5 million characters. */
  maxLength?: number;
}

/** Input for a policy-checked binary image fetch. */
export interface WebImageFetchRequest {
  /** Public HTTPS image URL. */
  url: string;
  /** Maximum accepted response size. Defaults to 5 MiB. */
  maxBytes?: number;
}

/** Binary image fetched through the web-search runtime's URL policy. */
export interface WebImageFetchResult {
  /** Final URL after redirects. */
  url: string;
  /** Image media type returned by the server. */
  contentType: string;
  /** Fetched image bytes. */
  data: Uint8Array;
}

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

/** Fetch and cache one raw page before caller-specific output reduction. */
async function fetchPage(
  requestUrl: string,
  runtime: WebSearchRuntime,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const { config } = runtime;
  await assertFetchUrlAllowed(requestUrl, config.allowList);
  const page = await executeRead(
    runtime,
    "page-fetch",
    toCallSettings(webFetchExecuteDefaults, config.timeoutMs, [
      "web-search",
      "fetch",
      requestUrl,
      ...config.allowList.patterns,
    ]),
    async (executeSignal): Promise<FetchedPage> => {
      const response = await gotScraping({
        url: requestUrl,
        // Bun's node:http2 reports default-port origins with :443 while
        // http2-wrapper compares them against URL-normalized origins.
        http2: false,
        // got's own timeout aborts the socket and reports which phase timed
        // out; the interceptor timeout bounds the whole attempt around it.
        timeout: { request: config.timeoutMs },
        throwHttpErrors: false,
        followRedirect: true,
        hooks: {
          beforeRequest: [
            async (options) => {
              await assertFetchUrlAllowed(String(options.url), config.allowList);
            },
          ],
        },
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      return {
        url: response.url ?? requestUrl,
        statusCode: response.statusCode,
        contentType: response.headers["content-type"],
        body: typeof response.body === "string" ? response.body : String(response.body ?? ""),
      };
    },
    signal,
  );
  await assertFetchUrlAllowed(page.url, config.allowList);
  return page;
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
  runtimeOrConfig: WebSearchRuntimeInput,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  const runtime = toWebSearchRuntime(runtimeOrConfig);
  const { config } = runtime;
  const cap = Math.min(request.maxLength ?? config.fetchMaxLength, config.fetchMaxLength);
  const page = await fetchPage(request.url, runtime, signal);

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

/**
 * Fetch bounded raw markup for deterministic in-process asset discovery.
 *
 * This does not widen the model-facing `web_fetch` cap.
 */
export async function runWebAssetPageFetch(
  request: WebAssetPageFetchRequest,
  runtimeOrConfig: WebSearchRuntimeInput,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  const runtime = toWebSearchRuntime(runtimeOrConfig);
  const cap = Math.min(
    Math.max(1, request.maxLength ?? DEFAULT_ASSET_PAGE_MAX_LENGTH),
    DEFAULT_ASSET_PAGE_MAX_LENGTH,
  );
  const page = await fetchPage(request.url, runtime, signal);
  const { content, truncated } = truncate(page.body, cap);
  const title = extractTitle(page.body);
  return {
    url: page.url,
    status: page.statusCode,
    ...(page.contentType ? { contentType: page.contentType } : {}),
    ...(title ? { title } : {}),
    content,
    truncated,
  };
}

/** Fetch one public image while preserving URL policy, timeout, and redirect checks. */
export async function runWebImageFetch(
  request: WebImageFetchRequest,
  runtimeOrConfig: WebSearchRuntimeInput,
  signal?: AbortSignal,
): Promise<WebImageFetchResult> {
  const runtime = toWebSearchRuntime(runtimeOrConfig);
  const { config } = runtime;
  const maxBytes = Math.max(1, request.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES);
  await assertFetchUrlAllowed(request.url, config.allowList);
  const page = await executeRead(
    runtime,
    "image-fetch",
    {
      default: {
        cache: { enabled: false },
        retry: { enabled: true, attempts: 2 },
        timeout: config.timeoutMs,
      },
    },
    async (executeSignal) => {
      const response = await gotScraping({
        url: request.url,
        responseType: "buffer",
        http2: false,
        timeout: { request: config.timeoutMs },
        throwHttpErrors: true,
        followRedirect: true,
        hooks: {
          beforeRequest: [
            async (options) => {
              await assertFetchUrlAllowed(String(options.url), config.allowList);
            },
          ],
        },
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      const contentType = String(response.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!contentType.startsWith("image/")) {
        throw new TypeError(`Expected an image response, received ${contentType || "unknown"}`);
      }
      if (response.body.byteLength > maxBytes) {
        throw new RangeError(`Image response exceeds ${maxBytes} bytes`);
      }
      return {
        url: response.url ?? request.url,
        contentType,
        data: new Uint8Array(response.body),
      };
    },
    signal,
    false,
  );
  await assertFetchUrlAllowed(page.url, config.allowList);
  return page;
}
