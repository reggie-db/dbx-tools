/**
 * Wire-format contract for the web-search add-on: the two tool inputs a
 * model fills in (`web_search`, `web_fetch`) and the results handed back.
 * Pure zod + inferred types (no Node-only imports) so the tool layer, the
 * plugin, and any future UI validate / type against one definition.
 *
 * Array fields intentionally avoid `.min()` / `.nonempty()`: those emit
 * `minItems` in the JSON schema, which some Model Serving endpoints reject
 * ("array types do not support minItems") when the schema is forwarded as a
 * tool definition - the same constraint the email add-on documents.
 *
 * @module
 */

import { string } from "@dbx-tools/shared-core";
import { z } from "zod";

/** The metasearch backends {@link https://www.npmjs.com/package/duck-duck-scrape | duck-duck-scrape} drives. */
export const searchBackendSchema = z
  .enum(["text", "news"])
  .describe(
    'Which result modality to query: "text" for general web pages (default), "news" for recent news articles.',
  );

/** A search modality ({@link searchBackendSchema}). */
export type SearchBackend = z.infer<typeof searchBackendSchema>;

/** Safe-search strength forwarded to the backend. */
export const safeSearchSchema = z
  .enum(["strict", "moderate", "off"])
  .describe('Adult-content filter strength: "strict", "moderate" (default), or "off".');

/** Safe-search strength ({@link safeSearchSchema}). */
export type SafeSearch = z.infer<typeof safeSearchSchema>;

/** Schema for the `web_search` tool input. */
export const webSearchRequestSchema = z.object({
  query: z
    .string()
    .describe(
      "The search query. Use natural keywords; the backend does not support boolean operators.",
    ),
  backend: searchBackendSchema.optional(),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum results to return (the plugin caps this at its configured limit). Defaults to the plugin's configured maximum.",
    ),
  safeSearch: safeSearchSchema.optional(),
  region: z
    .string()
    .optional()
    .describe('Region/locale for results, e.g. "us-en", "uk-en", "wt-wt" (any region). Defaults to the plugin config.'),
});

/** A validated `web_search` request. */
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;

/** Schema for a single search hit. */
export const webSearchResultItemSchema = z.object({
  title: z.string().describe("The result's page title."),
  url: z.string().describe("The result's canonical URL."),
  snippet: z.string().describe("A short plain-text description / excerpt of the result."),
  hostname: z.string().describe('The result host (e.g. "docs.databricks.com").'),
});

/** A single web-search hit ({@link webSearchResultItemSchema}). */
export type WebSearchResultItem = z.infer<typeof webSearchResultItemSchema>;

/** Schema for the `web_search` tool output. */
export const webSearchResultSchema = z.object({
  query: z.string().describe("Echo of the query that was searched."),
  results: z
    .array(webSearchResultItemSchema)
    .describe(
      "Ranked results. When an allow-list is configured, results whose URL is not permitted are silently omitted.",
    ),
});

/** The outcome of a `web_search` call ({@link webSearchResultSchema}). */
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

/** Schema for the `web_fetch` tool input. */
export const webFetchRequestSchema = z.object({
  url: z
    .string()
    .describe(
      "The absolute URL to fetch (must include the scheme, e.g. https://). When an allow-list is configured, a URL it does not permit is refused.",
    ),
  format: z
    .enum(["text", "html"])
    .optional()
    .describe(
      string.toDescription(`
        Return format: "text" (default) strips the page to readable plain
        text; "html" returns the raw response body. Prefer "text" unless you
        need the markup.
      `),
    ),
  maxLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Truncate the returned content to at most this many characters (the plugin caps this at its configured limit).",
    ),
});

/** A validated `web_fetch` request. */
export type WebFetchRequest = z.infer<typeof webFetchRequestSchema>;

/** Schema for the `web_fetch` tool output. */
export const webFetchResultSchema = z.object({
  url: z.string().describe("The final URL fetched (after redirects)."),
  status: z.number().describe("HTTP status code of the response."),
  contentType: z.string().optional().describe("Response `Content-Type`, when the server sent one."),
  title: z.string().optional().describe("The page <title>, when one was present."),
  content: z.string().describe("The page content in the requested format (text or html)."),
  truncated: z.boolean().describe("True when `content` was cut off at the length cap."),
});

/** The outcome of a `web_fetch` call ({@link webFetchResultSchema}). */
export type WebFetchResult = z.infer<typeof webFetchResultSchema>;
