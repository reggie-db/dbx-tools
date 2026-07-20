/**
 * AppKit plugin (registered name: `web-search`) that owns the resolved
 * web-search runtime - the URL allow-list, result / length caps, timeout,
 * and default approval gate the {@link webSearchTool} / {@link webFetchTool}
 * read. Registering it resolves and logs the effective config (whether an
 * allow-list is active, the caps) so a misconfiguration is visible in the
 * boot logs rather than on the first search.
 *
 * The tools do the actual work when spread into an agent; this plugin primes
 * the shared runtime they reuse and exposes direct {@link runWebSearch} /
 * {@link runWebFetch} for non-agent callers.
 *
 * @module
 */

import { getExecutionContext, Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import { log } from "@dbx-tools/shared-core";
import { WEB_SEARCH_CONFIG_SCHEMA, type WebSearchPluginConfig } from "./config";
import { runWebFetch } from "./fetch";
import { getWebSearchRuntime } from "./runtime";
import type { WebFetchRequest, WebFetchResult, WebSearchRequest, WebSearchResult } from "./schema";
import { runWebSearch, type WebSearchContext } from "./search";

/**
 * AppKit plugin that resolves and holds the web-search runtime config used
 * by the `web_search` / `web_fetch` tools.
 */
export class WebSearchPlugin extends Plugin<WebSearchPluginConfig> {
  static manifest = {
    name: "web-search",
    displayName: "Web Search",
    description:
      "Searches the web (via duck-duck-scrape) and fetches pages (via got-scraping), " +
      "with an optional URL allow-list and per-tool approval gating.",
    stability: "beta",
    resources: {
      required: [],
      optional: [],
    },
    config: { schema: WEB_SEARCH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"web-search">;

  private logger = log.logger(this);

  /**
   * Prime the shared runtime from this plugin's config (over env) and log
   * the effective policy so an active allow-list / caps are obvious at boot.
   */
  override async setup(): Promise<void> {
    const { config } = getWebSearchRuntime(this.config);
    this.logger.info("ready", {
      model: config.model ?? `fallbacks:[${config.modelFallbacks.join(", ")}]`,
      restricted: config.allowList.restricted,
      ...(config.allowList.restricted ? { allowedUrls: config.allowList.patterns } : {}),
      maxCitations: config.maxCitations,
      fetchMaxLength: config.fetchMaxLength,
      approval: config.approval === false ? "none" : config.approval,
    });
  }

  /** Resolve the OBO client + host from the active execution context. */
  private async searchContext(): Promise<WebSearchContext> {
    const ctx = getExecutionContext();
    const host = (await ctx.client.config.getHost()).toString();
    return { client: ctx.client, host };
  }

  override exports() {
    return {
      /**
       * Run a web search directly (bypassing the agent tool). Resolves the
       * OBO client from the active execution context and reads the shared
       * runtime config primed at setup.
       */
      search: async (request: WebSearchRequest): Promise<WebSearchResult> =>
        runWebSearch(request, getWebSearchRuntime().config, await this.searchContext()),
      /**
       * Fetch one URL directly (bypassing the agent tool). Enforces the
       * configured allow-list. Reads the shared runtime config.
       */
      fetch: (request: WebFetchRequest): Promise<WebFetchResult> =>
        runWebFetch(request, getWebSearchRuntime().config),
    };
  }
}

export const webSearch = toPlugin(WebSearchPlugin);
