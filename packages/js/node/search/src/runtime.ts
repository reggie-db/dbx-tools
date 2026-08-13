/**
 * The shared AI Search runtime: the resolved config plus a single
 * {@link SearchClient} instance the plugin, the Mastra tools, and the routes
 * all read. Mirrors the web-search / email runtime pattern - the plugin primes
 * it from its config at setup, and everything else reads the same instance so
 * a tool invoked outside the agent still sees the deployment's config.
 *
 * @module
 */

import { createSearchClient, SearchClient, type SearchReadBackend } from "./client.ts";
import {
  resolveSearchConfig,
  type SearchPluginConfig,
  type ResolvedSearchConfig,
} from "./config.ts";

/** Configuration and provider used to build the shared extension runtime. */
export interface SearchRuntimeOptions {
  config?: SearchPluginConfig;
  readBackend?: SearchReadBackend;
}

/** The shared resolved config plus the client reads run through. */
export interface SearchRuntime {
  config: ResolvedSearchConfig;
  client: SearchClient;
  readBackend?: SearchReadBackend;
}

let runtime: SearchRuntime | undefined;

/**
 * Return the shared runtime, building it on first use from the supplied config
 * layered over environment defaults. Overrides are only read when the runtime
 * is first created, so prime it from the plugin's config at setup; subsequent
 * calls pass nothing and get the same instance.
 */
export function getSearchRuntime(options?: SearchRuntimeOptions): SearchRuntime {
  if (!runtime) {
    const config = resolveSearchConfig(options?.config);
    runtime = {
      config,
      client: createSearchClient(config, undefined, options?.readBackend),
      ...(options?.readBackend ? { readBackend: options.readBackend } : {}),
    };
  }
  return runtime;
}

/** Drop the memoized runtime so the next {@link getSearchRuntime} rebuilds it. */
export function resetSearchRuntime(): void {
  runtime = undefined;
}
