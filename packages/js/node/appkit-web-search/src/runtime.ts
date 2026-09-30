/**
 * Web-search runtime construction and execution helpers.
 *
 * Each plugin instance owns one runtime. Standalone tool factories create their
 * own runtime, so separate apps and direct consumers cannot overwrite each
 * other's policy or executor.
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

/** The resolved config plus the executor outbound calls run through. */
export interface WebSearchRuntime {
  config: ResolvedWebSearchConfig;
  execute: WebSearchExecutor;
}

/** Runtime-aware operation input, retaining resolved-config compatibility. */
export type WebSearchRuntimeInput = WebSearchRuntime | ResolvedWebSearchConfig;

/**
 * Executor used by standalone runtimes: run the call directly, mapping a throw
 * onto the same {@link ExecutionResult} shape so call sites branch on `ok`
 * either way.
 */
const directExecute = execution.directExecutor<WebSearchExecutionSettings>();

/** Build an isolated runtime for one plugin instance or standalone tool set. */
export function createWebSearchRuntime(
  overrides?: WebSearchPluginConfig,
  execute: WebSearchExecutor = directExecute,
): WebSearchRuntime {
  return { config: resolveWebSearchConfig(overrides), execute };
}

/** Build an isolated runtime from config that has already been resolved. */
export function createResolvedWebSearchRuntime(
  config: ResolvedWebSearchConfig,
  execute: WebSearchExecutor = directExecute,
): WebSearchRuntime {
  return { config, execute };
}

/** Normalize an explicit runtime or legacy resolved config for one operation. */
export function toWebSearchRuntime(input: WebSearchRuntimeInput): WebSearchRuntime {
  return "execute" in input ? input : createResolvedWebSearchRuntime(input);
}

/**
 * Build an isolated standalone runtime.
 *
 * @deprecated Use {@link createWebSearchRuntime}. This compatibility helper
 * returns a new runtime on every call and never reads or updates plugin state.
 */
export function getWebSearchRuntime(overrides?: WebSearchPluginConfig): WebSearchRuntime {
  return createWebSearchRuntime(overrides);
}

/** Install an executor on an explicit runtime. */
export function setWebSearchExecutor(runtime: WebSearchRuntime, execute: WebSearchExecutor): void;
/**
 * @deprecated Process-global executor registration is no longer supported.
 * Pass a runtime as the first argument or provide the executor to
 * {@link createWebSearchRuntime}.
 */
export function setWebSearchExecutor(execute: WebSearchExecutor): never;
export function setWebSearchExecutor(
  runtimeOrExecute: WebSearchRuntime | WebSearchExecutor,
  execute?: WebSearchExecutor,
): void {
  if (typeof runtimeOrExecute === "function") {
    throw new TypeError(
      "setWebSearchExecutor requires an explicit runtime; use createWebSearchRuntime(config, executor)",
    );
  }
  if (!execute) throw new TypeError("setWebSearchExecutor requires an executor");
  runtimeOrExecute.execute = execute;
}

/**
 * @deprecated Plugin runtimes are instance-owned and need no global reset.
 * This compatibility helper is intentionally a no-op.
 */
export function resetWebSearchRuntime(): void {
  return;
}

/**
 * Run one idempotent read through the runtime executor and unwrap it.
 *
 * `execute()` never throws, so a failed call arrives as `{ ok: false }` with
 * a status the interceptors already sanitized; it is logged here and re-raised
 * as a stable {@link ExecutionError} so an upstream message never becomes the
 * caller's error text. `signal` is the caller's own cancellation (an agent
 * run, a request teardown); it is merged with the signal the timeout
 * interceptor supplies so either one unwinds the I/O.
 */
export async function executeRead<T>(
  runtime: WebSearchRuntime,
  operation: string,
  settings: WebSearchExecutionSettings,
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return execution.run({
    operation,
    settings,
    execute: runtime.execute,
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
