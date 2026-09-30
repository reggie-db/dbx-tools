/**
 * AI Search runtime construction helpers.
 *
 * Each plugin and standalone tool set owns its runtime and client. Provider
 * attachment updates only that runtime, so two apps in one process can use
 * different backends without sharing state.
 *
 * @module
 */

import { createSearchClient, SearchClient, type SearchReadBackend } from "./client.ts";
import {
  resolveSearchConfig,
  type SearchPluginConfig,
  type ResolvedSearchConfig,
} from "./config.ts";

/** Configuration and provider used to build an extension runtime. */
export interface SearchRuntimeOptions {
  config?: SearchPluginConfig;
  readBackend?: SearchReadBackend;
}

/** The resolved config plus the client reads run through. */
export interface SearchRuntime {
  config: ResolvedSearchConfig;
  client: SearchClient;
  readBackend?: SearchReadBackend;
}

/** Build an isolated runtime for one plugin instance or standalone tool set. */
export function createSearchRuntime(options: SearchRuntimeOptions = {}): SearchRuntime {
  const config = resolveSearchConfig(options.config);
  return {
    config,
    client: createSearchClient(config, undefined, options.readBackend),
    ...(options.readBackend ? { readBackend: options.readBackend } : {}),
  };
}

/** Attach a provider to one runtime while preserving its object identity. */
export function setSearchReadBackend(runtime: SearchRuntime, readBackend: SearchReadBackend): void {
  runtime.readBackend = readBackend;
  runtime.client = createSearchClient(runtime.config, undefined, readBackend);
}

/**
 * Build an isolated standalone runtime.
 *
 * @deprecated Use {@link createSearchRuntime}. This compatibility helper
 * returns a new runtime on every call and never reads or updates plugin state.
 */
export function getSearchRuntime(options?: SearchRuntimeOptions): SearchRuntime {
  return createSearchRuntime(options);
}

/**
 * @deprecated Plugin runtimes are instance-owned and need no global reset.
 * This compatibility helper is intentionally a no-op.
 */
export function resetSearchRuntime(): void {
  return;
}
