/**
 * Provider detection + web-search tool-spec mapping for the Databricks
 * Model Serving native web-search tool.
 *
 * Databricks exposes web search as a first-party tool that runs *inside* a
 * model call: the model searches the web and folds the results into its
 * answer. The tool spec is provider-specific (see the Databricks docs,
 * `machine-learning/model-serving/web-search`):
 *
 * - OpenAI GPT models, via the Responses API (`/serving-endpoints/responses`):
 *   `tools: [{ "type": "web_search" }]`
 * - Google Gemini models, via Chat Completions
 *   (`/serving-endpoints/chat/completions`): `tools: [{ "google_search": {} }]`
 *
 * (Anthropic exposes it over MCP, which needs a different call shape; only
 * GPT + Gemini are wired here, matching what the platform supports today.)
 *
 * The provider family is detected from the endpoint id the same way
 * `@dbx-tools/shared-model`'s `classifyByFamily` keys off name substrings
 * (`gpt` / `gemini` / `claude`), so a resolved endpoint like
 * `databricks-gpt-5` or `databricks-gemini-3-pro` maps to its API shape.
 *
 * @module
 */

import { ValidationError } from "@databricks/appkit";
import { z } from "zod";

/** A web-search-capable model provider family. */
export type WebSearchProvider = "openai" | "gemini";

/** How a provider's native web-search call is shaped. */
export interface WebSearchProviderSpec {
  /**
   * Which serving REST surface to call. `"responses"` posts to
   * `/serving-endpoints/responses` (OpenAI Responses API); `"chat"` posts to
   * `/serving-endpoints/chat/completions`.
   */
  api: "responses" | "chat";
  /** The tool entry appended to the request's `tools` array. */
  tool: Record<string, unknown>;
}

/**
 * Built-in provider -> tool-spec map. Operators can override or extend this
 * per provider via the plugin's `webSearchTools` config (env
 * `WEB_SEARCH_TOOLS`), which is merged over these defaults.
 */
export const WEB_SEARCH_PROVIDERS: Readonly<Record<WebSearchProvider, WebSearchProviderSpec>> = {
  openai: { api: "responses", tool: { type: "web_search" } },
  gemini: { api: "chat", tool: { google_search: {} } },
};

/**
 * Detect the web-search provider family for an endpoint id, or `null` when
 * the model is not one of the web-search-capable families. Anthropic
 * (`opus`/`sonnet`/`haiku`) is intentionally excluded - it needs an MCP call
 * shape this module doesn't implement - so a Claude endpoint returns `null`
 * and is treated as unsupported.
 */
export function detectWebSearchProvider(modelId: string): WebSearchProvider | null {
  const n = modelId.toLowerCase();
  // gpt-oss open-weights don't carry the hosted web-search tool; only the
  // hosted GPT family (Responses API) does. Both contain "gpt", so exclude
  // the open-weights explicitly.
  if (n.includes("gpt") && !n.includes("gpt-oss")) return "openai";
  if (n.includes("gemini")) return "gemini";
  return null;
}

/** Whether `modelId` is a web-search-capable model. */
export function supportsWebSearch(modelId: string): boolean {
  return detectWebSearchProvider(modelId) !== null;
}

/**
 * Runtime shape of one entry in the operator override map. The map arrives as
 * parsed JSON (config or `WEB_SEARCH_TOOLS`), so it is validated rather than
 * asserted.
 */
const providerOverrideSchema = z.object({
  api: z.enum(["responses", "chat"]).optional(),
  tool: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Resolve the effective {@link WebSearchProviderSpec} for a provider: the
 * built-in default, with any operator override (the `webSearchTools` map,
 * keyed by provider) shallow-merged over it. An override may replace just the
 * `tool` (the common case - a new tool type) or also the `api`. An override
 * that is not one of those two fields is a deployment mistake that would
 * otherwise be silently dropped, so it throws.
 */
export function webSearchToolSpec(
  provider: WebSearchProvider,
  overrides?: Record<string, unknown>,
): WebSearchProviderSpec {
  const base = WEB_SEARCH_PROVIDERS[provider];
  const raw = overrides?.[provider];
  if (raw === undefined) return base;
  const parsed = providerOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    throw ValidationError.invalidValue(
      `webSearchTools.${provider}`,
      raw,
      'an object with an optional "api" ("responses" | "chat") and an optional "tool" object',
    );
  }
  return {
    api: parsed.data.api ?? base.api,
    tool: parsed.data.tool ?? base.tool,
  };
}
