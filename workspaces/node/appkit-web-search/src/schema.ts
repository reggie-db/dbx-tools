/**
 * Wire-format contract for the web-search add-on: the two tool inputs a
 * model fills in (`web_search`, `web_fetch`) and the results handed back.
 * Pure zod + inferred types (no Node-only imports) so the tool layer, the
 * plugin, and any future UI validate / type against one definition.
 *
 * `web_search` is backed by the Databricks Model Serving native web-search
 * tool (see `provider.ts`): the model searches the web server-side and
 * returns a synthesized answer plus the sources it used. `web_fetch` reads a
 * single page's contents via got-scraping.
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

/** Schema for the `web_search` tool input. */
export const webSearchRequestSchema = z.object({
  query: z
    .string()
    .describe(
      "What to search the web for, phrased as a natural-language question or request. The model searches and answers in one step.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        Optional web-search-capable model to use (a Databricks serving
        endpoint name like "databricks-gemini-3-pro", a loose name like "gpt"
        or "gemini", or a capability class). Defaults to the plugin's
        configured web-search model. The web-search tool resolves its own
        model independently of the calling agent's chat model, since not
        every chat model supports web search.
      `),
    ),
});

/** A validated `web_search` request. */
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;

/** Schema for a single source the model cited while answering. */
export const webSearchCitationSchema = z.object({
  url: z.string().describe("The source URL the answer drew on."),
  title: z.string().optional().describe("The source page title, when available."),
  snippet: z.string().optional().describe("A short excerpt from the source, when available."),
});

/** A single cited source ({@link webSearchCitationSchema}). */
export type WebSearchCitation = z.infer<typeof webSearchCitationSchema>;

/** Schema for the `web_search` tool output. */
export const webSearchResultSchema = z.object({
  query: z.string().describe("Echo of the query that was searched."),
  answer: z
    .string()
    .describe("The model's answer, synthesized from live web results."),
  citations: z
    .array(webSearchCitationSchema)
    .describe(
      "Sources the answer drew on. When an allow-list is configured, citations whose URL is not permitted are silently omitted.",
    ),
  model: z.string().describe("The serving endpoint that produced the answer."),
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
