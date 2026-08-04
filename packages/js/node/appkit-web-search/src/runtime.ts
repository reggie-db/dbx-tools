/**
 * The web-search runtime: a lazily-resolved, process-wide config shared by
 * the plugin and the `web_search` / `web_fetch` tools, so both read one
 * resolved allow-list / cap / timeout set. The first caller (normally the
 * plugin at setup) primes it from the plugin's config; later callers (the
 * tools' `execute`) reuse it.
 *
 * The runtime also carries the {@link WebSearchExecutor} every outbound call
 * runs through. The plugin installs its own `execute()` there at setup, which
 * is how the tools - plain functions with no plugin instance in scope - still
 * get AppKit's cache / retry / timeout / telemetry chain. Without a
 * registered plugin (a direct call from a script or a test) the calls still
 * run, just without interceptors.
 *
 * Unlike the email runtime there is no connection to pool - the backend is
 * stateless HTTP per call - so the runtime holds only the resolved config and
 * that executor.
 *
 * @module
 */

import { ExecutionError, type ExecutionResult } from "@databricks/appkit";
import { execution, log } from "@dbx-tools/shared-core";
import {
  resolveWebSearchConfig,
  type ResolvedWebSearchConfig,
  type WebSearchPluginConfig,
} from "./config.ts";
import type { WebSearchExecutionSettings } from "./defaults.ts";

const logger = log.logger("web-search/runtime");

/**
 * Runs one outbound call through AppKit's interceptor chain. Matches
 * `Plugin.execute()`, which never throws: a failure comes back as
 * `{ ok: false }`.
 */
export type WebSearchExecutor = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  settings: WebSearchExecutionSettings,
) => Promise<ExecutionResult<T>>;

/** The shared resolved config plus the executor outbound calls run through. */
export interface WebSearchRuntime {
  config: ResolvedWebSearchConfig;
  execute: WebSearchExecutor;
}

/**
 * Executor used until (or unless) the plugin installs its own: run the call
 * directly, mapping a throw onto the same {@link ExecutionResult} shape so
 * call sites branch on `ok` either way.
 */
const directExecute = execution.directExecutor<WebSearchExecutionSettings>();

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
    runtime = { config: resolveWebSearchConfig(overrides), execute: directExecute };
  }
  return runtime;
}

/**
 * Install the executor outbound calls run through. The plugin calls this at
 * setup with its own `execute()`; a second call replaces the previous one, so
 * a re-registered plugin does not leave the tools bound to a dead instance.
 */
export function setWebSearchExecutor(execute: WebSearchExecutor): void {
  getWebSearchRuntime().execute = execute;
}

/** Drop the memoized runtime so the next {@link getWebSearchRuntime} rebuilds it. */
export function resetWebSearchRuntime(): void {
  runtime = undefined;
}

/**
 * Run one idempotent read through the shared executor and unwrap it.
 *
 * `execute()` never throws, so a failed call arrives as `{ ok: false }` with
 * a status the interceptors already sanitized; it is logged here and re-raised
 * as a stable {@link ExecutionError} so an upstream message never becomes the
 * caller's error text. `signal` is the caller's own cancellation (an agent
 * run, a request teardown); it is merged with the signal the timeout
 * interceptor supplies so either one unwinds the I/O.
 */
export async function executeRead<T>(
  operation: string,
  settings: WebSearchExecutionSettings,
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { execute } = getWebSearchRuntime();
  return execution.run({
    operation,
    settings,
    execute,
    fn,
    signal,
    canceled: ExecutionError.canceled,
    failed: (failure) => {
      logger.warn("execution-failed", {
        operation: failure.operation,
        status: failure.status,
        error: failure.message,
      });
      return new ExecutionError(`web-search: ${failure.operation} failed`, {
        context: { operation: failure.operation, status: failure.status },
      });
    },
  });
}
