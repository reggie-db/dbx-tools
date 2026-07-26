/**
 * AppKit plugin (registered name: `web-search`) that owns the resolved
 * web-search runtime - the URL policy, result / length caps, timeout, and
 * default approval gate the {@link webSearchTool} / {@link webFetchTool}
 * read. Registering it resolves and logs the effective config (which URL
 * policy is in force, the caps) so a misconfiguration is visible in the boot
 * logs rather than on the first search, and installs the plugin's
 * `execute()` as the runtime's executor so every outbound call picks up
 * AppKit's cache / retry / timeout / telemetry chain.
 *
 * The plugin also implements AppKit's `ToolProvider`, so an AppKit agent gets
 * `web_search` / `web_fetch` without going through Mastra; the Mastra tools in
 * `tool.ts` are the other half and share the same runtime.
 *
 * @module
 */

import {
  Plugin,
  ResourceType,
  toPlugin,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
  type AgentToolDefinition,
  type ToolProvider,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import { log, string } from "@dbx-tools/shared-core";
import {
  MODEL_ENV,
  SERVING_ENDPOINT_ENV,
  WEB_SEARCH_CONFIG_SCHEMA,
  type WebSearchPluginConfig,
} from "./config";
import { runWebFetch } from "./fetch";
import { getWebSearchRuntime, resetWebSearchRuntime, setWebSearchExecutor } from "./runtime";
import {
  webFetchRequestSchema,
  webSearchRequestSchema,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "./schema";
import type { WebFetchRequest, WebFetchResult, WebSearchRequest, WebSearchResult } from "./schema";
import { resolveWebSearchContext, runWebSearch } from "./search";

const logger = log.logger("web-search");

/**
 * The Model Serving endpoint the native web-search tool runs on. Declared
 * optional because the plugin resolves a web-search-capable endpoint from the
 * live catalogue when nothing is pinned; {@link WebSearchPlugin.getResourceRequirements}
 * promotes it to required once a deployment names one. `CAN_QUERY` is the
 * weakest permission that can invoke an endpoint.
 */
const SERVING_ENDPOINT_RESOURCE = {
  type: ResourceType.SERVING_ENDPOINT,
  alias: "Web Search Endpoint",
  resourceKey: "web-search-endpoint",
  description:
    "Model Serving endpoint running the native web-search tool. Optional: resolved from the " +
    "workspace catalogue (Gemini, then GPT) when no endpoint is pinned.",
  permission: "CAN_QUERY",
  fields: {
    name: {
      env: SERVING_ENDPOINT_ENV,
      description: `Serving endpoint name for web search. ${MODEL_ENV} overrides it.`,
      discovery: {
        type: "cli",
        cliCommand: "databricks serving-endpoints list --profile <PROFILE> --output json",
        selectField: ".name",
      },
    },
  },
} satisfies Omit<ResourceRequirement, "required">;

/**
 * AppKit plugin that resolves and holds the web-search runtime config used
 * by the `web_search` / `web_fetch` tools.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as webSearchPlugin } from "@dbx-tools/appkit-web-search";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     webSearchPlugin.webSearch({
 *       model: "gemini",
 *       urlPolicy: "allowlist",
 *       allowedUrls: ["*.databricks.com"],
 *     }),
 *   ],
 * });
 * ```
 */
export class WebSearchPlugin extends Plugin<WebSearchPluginConfig> implements ToolProvider {
  static manifest = {
    name: "web-search",
    displayName: "Web Search",
    description:
      "Searches the web through the Databricks native web-search tool on its own " +
      "web-capable serving endpoint, and fetches pages via got-scraping, behind an " +
      "optional URL allow-list and per-tool approval gating.",
    stability: "beta",
    resources: {
      required: [],
      optional: [SERVING_ENDPOINT_RESOURCE],
    },
    config: { schema: WEB_SEARCH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"web-search">;

  /**
   * Promote the serving endpoint to a required resource once a deployment
   * pins one, through plugin config or either environment name. Left optional
   * otherwise, because the plugin picks a web-search-capable endpoint out of
   * the live catalogue on its own.
   */
  static getResourceRequirements(config: WebSearchPluginConfig): ResourceRequirement[] {
    const pinned =
      string.trimToNull(config.model) ??
      string.trimToNull(process.env[MODEL_ENV]) ??
      string.trimToNull(process.env[SERVING_ENDPOINT_ENV]);
    return pinned === null ? [] : [{ ...SERVING_ENDPOINT_RESOURCE, required: true }];
  }

  /**
   * The tools this plugin offers to an AppKit agent. Both are reads and both
   * run under the caller's identity.
   *
   * Neither is `autoInheritable`. `web_fetch` reaches a URL the model chose,
   * which is reachable from inside the workspace network, so it must only
   * appear in an agent that asked for it and accepted the URL policy that
   * comes with it. `web_search` is safer but still spends serving tokens on
   * every call, so it is opt-in for cost rather than for safety.
   *
   * `execute` re-parses its arguments with the local schema: AppKit validates
   * against the same schema first, but re-parsing is what gives the body typed
   * arguments instead of `unknown`.
   */
  private readonly tools: ToolRegistry = {
    web_search: defineTool({
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      schema: webSearchRequestSchema,
      annotations: { effect: "read", requiresUserContext: true },
      autoInheritable: false,
      execute: async (args, signal) => this.search(webSearchRequestSchema.parse(args), signal),
    }),
    web_fetch: defineTool({
      description: WEB_FETCH_TOOL_DESCRIPTION,
      schema: webFetchRequestSchema,
      annotations: { effect: "read", requiresUserContext: true },
      autoInheritable: false,
      execute: async (args, signal) => this.fetch(webFetchRequestSchema.parse(args), signal),
    }),
  };

  /**
   * Prime the shared runtime from this plugin's config (over env), route the
   * tools' outbound calls through this plugin's interceptor chain, and log the
   * effective policy so an active allow-list / caps are obvious at boot.
   */
  override async setup(): Promise<void> {
    const { config } = getWebSearchRuntime(this.config);
    setWebSearchExecutor((fn, settings) => this.execute(fn, settings));
    logger.info("ready", {
      model: config.model ?? `fallbacks:[${config.modelFallbacks.join(", ")}]`,
      modelSource: config.modelSource,
      urlPolicy: config.urlPolicy,
      ...(config.allowList.restricted ? { allowedUrls: config.allowList.patterns } : {}),
      maxCitations: config.maxCitations,
      fetchMaxLength: config.fetchMaxLength,
      approval: config.approval.mode,
      scrapeFallback: config.scrapeFallback,
    });
  }

  /**
   * Drop the shared runtime so a restarted app re-resolves config and does not
   * keep calling through a torn-down plugin's `execute()`. Bounded and
   * idempotent: there is no connection to drain, only the memo to clear.
   */
  async shutdown(): Promise<void> {
    resetWebSearchRuntime();
  }

  /**
   * Abort in-flight work. AppKit's graceful shutdown only invokes this hook -
   * it never calls {@link shutdown} - so the runtime memo is dropped from here
   * to keep a restarted app from calling through a torn-down `execute()`. The
   * teardown is synchronous and idempotent, so the un-awaited call costs
   * nothing.
   */
  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.shutdown();
  }

  /** AppKit `ToolProvider`: the tool definitions offered to an agent. */
  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  /**
   * AppKit `ToolProvider`: run one tool call. Arguments are validated against
   * the tool's schema first, and a validation failure comes back as an
   * LLM-friendly string so the model can correct itself on the next turn.
   */
  async executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  override exports() {
    return {
      /**
       * Run a web search directly (bypassing the agent tool). Resolves the
       * OBO client from the active execution context and reads the shared
       * runtime config primed at setup.
       */
      search: (request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> =>
        this.search(request, signal),
      /**
       * Fetch one URL directly (bypassing the agent tool). Enforces the
       * configured URL policy. Reads the shared runtime config.
       */
      fetch: (request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> =>
        this.fetch(request, signal),
    };
  }

  private async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return runWebSearch(
      request,
      getWebSearchRuntime().config,
      await resolveWebSearchContext(),
      signal,
    );
  }

  private async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    return runWebFetch(request, getWebSearchRuntime().config, signal);
  }
}

/**
 * Register the web-search runtime with AppKit.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as webSearchPlugin, tool as webTool } from "@dbx-tools/appkit-web-search";
 * import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";
 *
 * const researcher = agents.createAgent({
 *   instructions: "Research questions with web_search, then read sources with web_fetch.",
 *   tools: () => ({ web_search: webTool.webSearchTool(), web_fetch: webTool.webFetchTool() }),
 * });
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     webSearchPlugin.webSearch({ model: "gemini" }),
 *     mastraPlugin.mastra({ agents: researcher }),
 *   ],
 * });
 * ```
 */
export const webSearch = toPlugin(WebSearchPlugin);
