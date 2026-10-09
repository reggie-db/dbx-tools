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
 *   (`/serving-endpoints/chat/completions`): top-level `"google_search": {}`
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
import { metadata, policy } from "@dbx-tools/model";
import type { ServingEndpointSummary } from "@dbx-tools/shared-model";
import { z } from "zod";

/** A web-search-capable model provider family. */
export type WebSearchProvider = "openai" | "gemini";

/** Serialized provider request fragment for native web search. */
export const WebSearchProviderSpecSchema = z
  .object({
    api: z
      .enum(["responses", "chat"])
      .describe("Databricks serving API that accepts the provider request."),
    request: z
      .record(z.string(), z.unknown())
      .describe("Provider-specific fields merged into the serving request body."),
  })
  .strict()
  .describe("Native web-search request contract for one provider family.");

/** How a provider's native web-search call is shaped. */
export type WebSearchProviderSpec = z.infer<typeof WebSearchProviderSpecSchema>;

/**
 * Built-in provider -> tool-spec map. Operators can override or extend this
 * per provider via the plugin's `webSearchTools` config (env
 * `WEB_SEARCH_TOOLS`), which is merged over these defaults.
 */
export const WEB_SEARCH_PROVIDERS: Readonly<Record<WebSearchProvider, WebSearchProviderSpec>> = {
  openai: { api: "responses", request: { tools: [{ type: "web_search" }] } },
  gemini: { api: "chat", request: { google_search: {} } },
};

/**
 * Map a model-owned family value to its native web-search provider contract.
 */
export function webSearchProviderForFamily(
  family: policy.ModelFamily | undefined,
): WebSearchProvider | null {
  switch (family) {
    case policy.ModelFamily.Gpt:
      return "openai";
    case policy.ModelFamily.Gemini:
      return "gemini";
    default:
      return null;
  }
}

/** Whether a model has both native capability and a supported provider contract. */
export function supportsWebSearch(model: string | ServingEndpointSummary): boolean {
  const identity = typeof model === "string" ? model : (model.modelServiceName ?? model.name);
  return (
    webSearchProviderForFamily(policy.modelFamily(identity)) !== null &&
    metadata.modelCapabilitiesFor(model).webSearch
  );
}

/**
 * Runtime shape of one entry in the operator override map. The map arrives as
 * parsed JSON (config or `WEB_SEARCH_TOOLS`), so it is validated rather than
 * asserted.
 */
const providerOverrideSchema = WebSearchProviderSpecSchema.partial()
  .strict()
  .describe("Partial native web-search provider override.");

/**
 * Resolve the effective {@link WebSearchProviderSpec} for a provider: the
 * built-in default, with any operator override (the `webSearchTools` map,
 * keyed by provider) shallow-merged over it. An override may replace just the
 * `request` fragment or also the `api`. An override
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
      'an object with an optional "api" ("responses" | "chat") and an optional "request" object',
    );
  }
  return {
    api: parsed.data.api ?? base.api,
    request: parsed.data.request ?? base.request,
  };
}
