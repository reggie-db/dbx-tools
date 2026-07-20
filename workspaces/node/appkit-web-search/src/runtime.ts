/**
 * The web-search runtime: a lazily-resolved, process-wide config shared by
 * the plugin and the `web_search` / `web_fetch` tools, so both read one
 * resolved allow-list / cap / timeout set. The first caller (normally the
 * plugin at setup) primes it from the plugin's config; later callers (the
 * tools' `execute`) reuse it.
 *
 * Unlike the email runtime there is no connection to pool - the backend is
 * stateless HTTP per call - so the runtime holds only the resolved config.
 *
 * @module
 */

import { resolveWebSearchConfig, type ResolvedWebSearchConfig, type WebSearchPluginConfig } from "./config";

/** The shared resolved config. */
export interface WebSearchRuntime {
  config: ResolvedWebSearchConfig;
}

let runtime: WebSearchRuntime | undefined;

/**
 * Return the shared runtime, building it on first use from the supplied
 * config layered over environment defaults. Overrides are only read when the
 * runtime is first created, so prime it from the plugin's config at setup;
 * subsequent calls (the tools' `execute`) pass nothing and get the same
 * instance.
 */
export function getWebSearchRuntime(overrides?: WebSearchPluginConfig): WebSearchRuntime {
  if (!runtime) {
    runtime = { config: resolveWebSearchConfig(overrides) };
  }
  return runtime;
}

/** Drop the memoized runtime so the next {@link getWebSearchRuntime} rebuilds it. */
export function resetWebSearchRuntime(): void {
  runtime = undefined;
}
