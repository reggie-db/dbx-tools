/**
 * The shared AI Search runtime: the resolved config plus a single
 * {@link SearchClient} instance the plugin, the Mastra tools, and the routes
 * all read. Mirrors the web-search / email runtime pattern - the plugin primes
 * it from its config at setup, and everything else reads the same instance so
 * a tool invoked outside the agent still sees the deployment's config.
 *
 * @module
 */

import { createSearchClient, SearchClient } from "./client.ts";
import {
  resolveAiSearchConfig,
  type AiSearchPluginConfig,
  type ResolvedAiSearchConfig,
} from "./config.ts";

/** The shared resolved config plus the client reads run through. */
export interface AiSearchRuntime {
  config: ResolvedAiSearchConfig;
  client: SearchClient;
}

let runtime: AiSearchRuntime | undefined;

/**
 * Return the shared runtime, building it on first use from the supplied config
 * layered over environment defaults. Overrides are only read when the runtime
 * is first created, so prime it from the plugin's config at setup; subsequent
 * calls pass nothing and get the same instance.
 */
export function getAiSearchRuntime(overrides?: AiSearchPluginConfig): AiSearchRuntime {
  if (!runtime) {
    const config = resolveAiSearchConfig(overrides);
    runtime = { config, client: createSearchClient(config) };
  }
  return runtime;
}

/** Drop the memoized runtime so the next {@link getAiSearchRuntime} rebuilds it. */
export function resetAiSearchRuntime(): void {
  runtime = undefined;
}
