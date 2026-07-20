/**
 * The `web_search` and `web_fetch` Mastra tools.
 *
 * `web_search` is backed by the Databricks Model Serving native web-search
 * tool: it resolves its own web-search-capable model (see `search.ts`) and
 * calls the workspace serving endpoint under the caller's OBO scope, so the
 * search runs as the requesting user and independently of the agent's chat
 * model. `web_fetch` reads a page via got-scraping.
 *
 * Both are read-only and run without approval by default; each accepts an
 * optional {@link ApprovalGate} (`approval`) that maps onto Mastra's
 * `requireApproval`. `true` gates every call; a URL-pattern (or {@link OneOrMany}
 * list) gates only calls whose URL matches - for `web_fetch` that is evaluated
 * against the target URL, while `web_search` (whose result URLs aren't known
 * before the call) treats a pattern gate as "always gate". `approval` falls
 * back to the plugin's `approval` config when a tool omits its own.
 *
 * @module
 */

import { getExecutionContext } from "@databricks/appkit";
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
import { runWebSearch, type WebSearchContext } from "./search";

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
 * Resolve the OBO workspace client + host from the active AppKit execution
 * context. Runs inside `agent.stream`'s `asUser(req)` scope, so the search
 * hits the serving endpoint as the requesting user; outside a user context it
 * falls back to the service principal.
 */
async function webSearchContext(): Promise<WebSearchContext> {
  const ctx = getExecutionContext();
  const host = (await ctx.client.config.getHost()).toString();
  return { client: ctx.client, host };
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
      Search the web for current information and get an answer synthesized from
      live results, with the sources it used. Pass a natural-language query;
      the search runs inside a web-search-capable model (chosen independently
      of your own model). Optionally pass a model name to use a specific
      web-search model. Use it whenever a question needs up-to-date or external
      information you don't already have.
    `),
    inputSchema: webSearchRequestSchema,
    outputSchema: webSearchResultSchema,
    // A search's result URLs aren't known before the call, so a pattern gate
    // is treated as "always gate"; boolean gates pass through.
    ...(gate === false || gate === undefined
      ? {}
      : { requireApproval: () => (typeof gate === "boolean" ? gate : true) }),
    execute: async (input) => {
      const { config } = getWebSearchRuntime();
      return runWebSearch(input as WebSearchRequest, config, await webSearchContext());
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
      instead of extracted text. Use it to read a page returned by web_search
      or provided by the user. Content is length-capped; fetching a URL outside
      the configured allow-list is refused.
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
