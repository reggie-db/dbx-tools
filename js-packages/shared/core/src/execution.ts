/** Generic helpers for AppKit-style intercepted execution. */
import * as async from "./async.ts";
import * as error from "./error.ts";
import * as object from "./object.ts";

/** Success/failure shape returned by an interceptor-backed executor. */
export type ExecutionResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string };

/** Function signature shared by AppKit plugin executors. */
export type Executor<Settings> = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  settings: Settings,
) => Promise<ExecutionResult<T>>;

/** Failure details supplied when an intercepted operation cannot complete. */
export interface ExecutionFailure {
  operation: string;
  status: number;
  message: string;
}

/** Options for running and unwrapping one intercepted operation. */
export interface RunOptions<T, Settings> {
  operation: string;
  settings: Settings;
  execute: Executor<Settings>;
  fn: (signal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  canceled: () => Error;
  failed: (failure: ExecutionFailure) => Error;
}

function errorStatus(value: unknown): number {
  if (!object.isRecord(value)) return 500;
  const status = value.statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : 500;
}

/**
 * Build the executor used before a plugin installs its interceptor chain.
 * Errors are mapped onto the same result shape as AppKit's `Plugin.execute()`.
 */
export function directExecutor<Settings>(): Executor<Settings> {
  return async (fn) => {
    try {
      return { ok: true, data: await fn() };
    } catch (cause) {
      return {
        ok: false,
        status: errorStatus(cause),
        message: error.errorMessage(cause),
      };
    }
  };
}

/** Run an operation through an executor, merge cancellation, and unwrap its result. */
export async function run<T, Settings>(options: RunOptions<T, Settings>): Promise<T> {
  const result = await options.execute(
    (executeSignal) => options.fn(async.combineAbortSignals(executeSignal, options.signal)),
    options.settings,
  );
  if (result.ok) return result.data;
  if (options.signal?.aborted) throw options.canceled();
  throw options.failed({
    operation: options.operation,
    status: result.status,
    message: result.message,
  });
}
