/** AppKit-specific adapters over the shared intercepted-execution contract. */

import { ExecutionError } from "@databricks/appkit";
import { type Logger, toError, type Executor, run } from "@dbx-tools/shared-core";

/** Inputs for one plugin operation routed through AppKit interceptors. */
export interface RunPluginExecutionOptions<T, Settings> {
  readonly plugin: string;
  readonly logger: Pick<Logger, "warn">;
  readonly operation: string;
  readonly settings: Settings;
  readonly execute: Executor<Settings>;
  readonly fn: (signal?: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}

/**
 * Run and unwrap one AppKit plugin operation with the shared stable failure
 * message, structured warning, status context, and cancellation behavior.
 */
export function runPluginExecution<T, Settings>(
  options: RunPluginExecutionOptions<T, Settings>,
): Promise<T> {
  return run({
    operation: options.operation,
    settings: options.settings,
    execute: options.execute,
    fn: options.fn,
    signal: options.signal,
    canceled: ExecutionError.canceled,
    failed: (failure) => {
      options.logger.warn("execution-failed", {
        operation: failure.operation,
        status: failure.status,
        error: toError(failure.message),
      });
      return new ExecutionError(`${options.plugin}: ${failure.operation} failed`, {
        context: { operation: failure.operation, status: failure.status },
      });
    },
  });
}
