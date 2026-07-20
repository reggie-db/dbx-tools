/**
 * The `web_search` and `web_fetch` Mastra tools. Both are read-only and run
 * without approval by default; each accepts an optional {@link ApprovalGate}
 * (`approval`) that maps onto Mastra's `requireApproval`. `true` gates every
 * call; a URL-pattern (or {@link OneOrMany} list of them) gates only calls
 * whose URL(s) match - a search is gated when any candidate result URL
 * matches, a fetch when its target matches - so a deployment can require a
 * human click before, say, anything off an internal domain is fetched while
 * letting ordinary searches run freely.
 *
 * `approval` falls back to the plugin's `approval` config when a tool omits
 * its own. Both tools read the shared runtime config (allow-list, caps,
 * timeout) primed by the plugin at setup.
 *
 * @module
 */

import { string } from "@dbx-tools/shared-core";
import { createTool } from "@mastra/core/tools";
import { approvalMatches, type ApprovalGate } from "./config";
import { runWebFetch } from "./fetch";
import { getWebSearchRuntime } from "./runtime";
import {
  webFetchRequestSchema,
  webFetchResultSchema,
  webSearchRequestSchema,
  webSearchResultSchema,
  type WebFetchRequest,
  type WebSearchRequest,
} from "./schema";
import { runWebSearch } from "./search";

/** Options shared by both web tools. */
export interface WebSearchToolOptions {
  /** Override the tool id. */
  id?: string;
  /**
   * Approval gate for this tool, overriding the plugin's `approval`. `true`
   * gates every call; a URL-pattern (or list) gates only matching calls;
   * omit / `false` for no approval. See {@link ApprovalGate}.
   */
  approval?: ApprovalGate;
}

/** Resolve the effective gate: explicit tool option, else the plugin default. */
function effectiveGate(opts: WebSearchToolOptions): ApprovalGate {
  return opts.approval ?? getWebSearchRuntime().config.approval;
}

/**
 * Build the `web_search` tool. Spread it into the agents that should be able
 * to search the web.
 *
 * @example
 * ```ts
 * import { webSearchTool } from "@dbx-tools/appkit-web-search";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const researcher = createAgent({
 *   instructions: "...",
 *   tools: () => ({ web_search: webSearchTool() }),
 * });
 * ```
 */
export function webSearchTool(opts: WebSearchToolOptions = {}) {
  const gate = effectiveGate(opts);
  return createTool({
    id: opts.id ?? "web_search",
    description: string.toDescription(`
      Search the web and return ranked results (title, URL, and a short
      snippet). Use it to find current information, documentation, or sources
      you can then read with web_fetch. Pass a natural-language query; boolean
      operators are not supported. Set backend to "news" for recent articles.
      Results may be filtered to an allow-list of permitted sites.
    `),
    inputSchema: webSearchRequestSchema,
    outputSchema: webSearchResultSchema,
    // Gate only when configured. For a pattern gate we don't yet know the
    // result URLs at approval time, so `true`/`false` short-circuit and a
    // pattern gate falls back to always gating a search (the safe reading:
    // any result could match). A fetch gate is precise (it knows its URL).
    ...(gate === false || gate === undefined
      ? {}
      : { requireApproval: () => (typeof gate === "boolean" ? gate : true) }),
    execute: async (input) => {
      const { config } = getWebSearchRuntime();
      return runWebSearch(input as WebSearchRequest, config);
    },
  });
}

/**
 * Build the `web_fetch` tool. Spread it into the agents that should be able
 * to read a page's contents.
 *
 * @example
 * ```ts
 * import { webFetchTool } from "@dbx-tools/appkit-web-search";
 *
 * tools: () => ({ web_fetch: webFetchTool({ approval: "*.internal.example.com" }) })
 * ```
 */
export function webFetchTool(opts: WebSearchToolOptions = {}) {
  const gate = effectiveGate(opts);
  return createTool({
    id: opts.id ?? "web_fetch",
    description: string.toDescription(`
      Fetch a single web page and return its readable contents. Pass an
      absolute URL (including https://); set format to "html" for raw markup
      instead of extracted text. Use it to read a page you found with
      web_search or that the user provided. Content is length-capped; fetching
      a URL outside the configured allow-list is refused.
    `),
    inputSchema: webFetchRequestSchema,
    outputSchema: webFetchResultSchema,
    // A fetch knows its single target URL, so a pattern gate is evaluated
    // precisely against it; boolean gates pass through.
    ...(gate === false || gate === undefined
      ? {}
      : {
          requireApproval: (input: unknown) =>
            approvalMatches(gate, [(input as WebFetchRequest).url]),
        }),
    execute: async (input) => {
      const { config } = getWebSearchRuntime();
      return runWebFetch(input as WebFetchRequest, config);
    },
  });
}
