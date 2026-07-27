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
 * The same two tools are exposed to AppKit's own agents through the plugin's
 * `ToolProvider` (see `plugin.ts`); this module is the Mastra half.
 *
 * @module
 */

import { ValidationError } from "@databricks/appkit";
import { createTool } from "@mastra/core/tools";
import type { z } from "zod";
import {
  approvalMatches,
  toApprovalPolicy,
  type ApprovalGate,
  type ApprovalPolicy,
} from "./config";
import { runWebFetch } from "./fetch";
import { getWebSearchRuntime } from "./runtime";
import {
  webFetchRequestSchema,
  webFetchResultSchema,
  webSearchRequestSchema,
  webSearchResultSchema,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "./schema";
import { resolveWebSearchContext, runWebSearch } from "./search";

/**
 * Validate a tool call's arguments at the runtime boundary. Mastra checks the
 * input schema before dispatch, but the argument still arrives typed as
 * `unknown` and the model is the one filling it in. The rejected value is not
 * echoed back.
 */
function parseToolInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.invalidValue("input", input, "arguments matching the tool's schema");
  }
  return parsed.data;
}

/** Options shared by both web tools. */
export interface WebSearchToolOptions {
  /** Override the tool id. */
  id?: string;
  /**
   * Approval gate for this tool, overriding the plugin's `approval`. `true`
   * gates every call; a URL-pattern (or list) gates only matching calls;
   * omit / `false` for no approval. See {@link ApprovalGate}.
   */
  approval?: ApprovalGate | ApprovalPolicy;
}

/** Resolve the effective gate: explicit tool option, else the plugin default. */
function effectiveGate(opts: WebSearchToolOptions): ApprovalPolicy {
  return opts.approval === undefined
    ? getWebSearchRuntime().config.approval
    : toApprovalPolicy(opts.approval);
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
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: webSearchRequestSchema,
    outputSchema: webSearchResultSchema,
    // A search's result URLs aren't known before the call, so a pattern gate
    // is treated as "always gate".
    ...(gate.mode === "none" ? {} : { requireApproval: () => true }),
    execute: async (input) => {
      const { config } = getWebSearchRuntime();
      const request = parseToolInput(webSearchRequestSchema, input);
      return runWebSearch(request, config, await resolveWebSearchContext());
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
    description: WEB_FETCH_TOOL_DESCRIPTION,
    inputSchema: webFetchRequestSchema,
    outputSchema: webFetchResultSchema,
    // A fetch knows its single target URL, so a pattern gate is evaluated
    // precisely against it.
    ...(gate.mode === "none"
      ? {}
      : {
          requireApproval: (input: unknown) =>
            gate.mode === "always" ||
            approvalMatches(gate, [parseToolInput(webFetchRequestSchema, input).url]),
        }),
    execute: async (input) => {
      const { config } = getWebSearchRuntime();
      return runWebFetch(parseToolInput(webFetchRequestSchema, input), config);
    },
  });
}
