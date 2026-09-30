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
 * back to the standalone runtime's `approval` config when a tool omits its own.
 *
 * App-integrated agents should consume the plugin's native toolkit so calls
 * retain that plugin's policy and executor. These factories are the standalone
 * Mastra surface and capture an explicit runtime or isolated config.
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
  type WebSearchPluginConfig,
} from "./config.ts";
import { runWebFetch } from "./fetch.ts";
import { createWebSearchRuntime, type WebSearchRuntime } from "./runtime.ts";
import {
  webFetchRequestSchema,
  webFetchResultSchema,
  webSearchRequestSchema,
  webSearchResultSchema,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "./schema.ts";
import { resolveWebSearchContext, runWebSearch } from "./search.ts";

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
  /** Isolated runtime used by this standalone tool. Mutually exclusive with `config`. */
  runtime?: WebSearchRuntime;
  /** Config used to create an isolated direct-execution runtime. */
  config?: WebSearchPluginConfig;
  /**
   * Approval gate for this tool, overriding the runtime's `approval`. `true`
   * gates every call; a URL-pattern (or list) gates only matching calls;
   * omit / `false` for no approval. See {@link ApprovalGate}.
   */
  approval?: ApprovalGate | ApprovalPolicy;
}

/** Resolve the isolated runtime captured by one standalone tool factory. */
function toolRuntime(opts: WebSearchToolOptions): WebSearchRuntime {
  if (opts.runtime && opts.config) {
    throw new TypeError("web-search tool options accept either runtime or config, not both");
  }
  return opts.runtime ?? createWebSearchRuntime(opts.config);
}

/** Resolve the effective gate: explicit tool option, else the runtime default. */
function effectiveGate(opts: WebSearchToolOptions, runtime: WebSearchRuntime): ApprovalPolicy {
  return opts.approval === undefined ? runtime.config.approval : toApprovalPolicy(opts.approval);
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
  const runtime = toolRuntime(opts);
  const gate = effectiveGate(opts, runtime);
  return createTool({
    id: opts.id ?? "web_search",
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: webSearchRequestSchema,
    outputSchema: webSearchResultSchema,
    // A search's result URLs aren't known before the call, so a pattern gate
    // is treated as "always gate".
    ...(gate.mode === "none" ? {} : { requireApproval: () => true }),
    execute: async (input) => {
      const request = parseToolInput(webSearchRequestSchema, input);
      return runWebSearch(request, runtime, await resolveWebSearchContext());
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
  const runtime = toolRuntime(opts);
  const gate = effectiveGate(opts, runtime);
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
      return runWebFetch(parseToolInput(webFetchRequestSchema, input), runtime);
    },
  });
}
