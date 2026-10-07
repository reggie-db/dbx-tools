/**
 * Node Graphiti runtime.
 *
 * Callers configure and control Graphiti through the typed lifecycle API in
 * this module. Process supervision, model routing, authentication, and
 * persistence remain internal details.
 *
 * @module
 */
import * as exec from "@dbx-tools/core/exec";
import {
  graphitiOptionsEnvironment,
  resolveGraphitiOptions,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "./options.ts";

/** Shared Graphiti options accepted by runtime callers. */
export type GraphitiRuntimeOptions = GraphitiOptions;

/** Running Graphiti stack controlled by one Node process. */
export interface GraphitiRuntime {
  /** Fully defaulted runtime configuration. */
  readonly options: ResolvedGraphitiOptions;
  /** Resolves when a supervised process exits, after all siblings are stopped. */
  readonly result: Promise<void>;
  /** Stop the supervised Graphiti runtime and its database. */
  stop(): Promise<void>;
}

/** Build the private process environment from the exact shared configuration. */
function _runtimeEnvironment(options: ResolvedGraphitiOptions): NodeJS.ProcessEnv {
  if (options.listen.scheme !== "tcp") throw new Error("Graphiti requires a TCP listener");
  return {
    ...process.env,
    ...graphitiOptionsEnvironment(options),
    UVICORN_HOST: options.listen.host,
    UVICORN_PORT: String(options.listen.port),
  };
}

/** Start one Graphiti runtime from the shared typed options. */
export async function startGraphitiRuntime(
  options: GraphitiRuntimeOptions = {},
): Promise<GraphitiRuntime> {
  const resolved = resolveGraphitiOptions(options);
  const python = process.env.PYTHON;
  // Managed services supply their uv interpreter; foreground runs resolve the
  // lockstep Python distribution through uv's cached package environment.
  const packageArgs = python
    ? []
    : ["--with", `dbx-tools-graphiti==${(await import("../index.ts")).PACKAGE_VERSION}`];
  const child = exec.spawn(
    "uv",
    [
      "run",
      "--no-project",
      ...packageArgs,
      "--python",
      python ?? "python3",
      "python",
      "-m",
      "uvicorn",
      "dbx_tools.graphiti.main:app",
    ],
    {
      detached: process.platform !== "win32",
      env: _runtimeEnvironment(resolved),
    },
  );
  return managedRuntime(resolved, child);
}

/** Run the supervised stack until one child exits or the process is signaled. */
export async function runGraphiti(options: GraphitiRuntimeOptions = {}): Promise<void> {
  const runtime = await startGraphitiRuntime(options);
  const dispose = installSignalHandlers(runtime);
  try {
    await runtime.result;
  } finally {
    dispose();
  }
}

function managedRuntime(
  options: ResolvedGraphitiOptions,
  child: exec.ChildProcessResult,
): GraphitiRuntime {
  let closing: Promise<void> | undefined;
  let stopping = false;
  const stop = (): Promise<void> => {
    closing ??= (async () => {
      stopping = true;
      signalChild(child, "SIGTERM");
      const exited = await Promise.race([
        child.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 13_000)),
      ]);
      if (!exited) {
        signalChild(child, "SIGKILL");
        await child;
      }
    })();
    return closing;
  };
  const result = child
    .then((outcome) => {
      if (outcome.exitCode !== 0 && !stopping) {
        throw new Error(`Graphiti child exited with status ${outcome.exitCode}`);
      }
    })
    .finally(stop);
  return { options, result, stop };
}

function signalChild(child: exec.ChildProcessResult, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group already exited; the direct child fallback is harmless.
    }
  }
  child.kill(signal);
}

function installSignalHandlers(runtime: GraphitiRuntime): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      for (const [name, callback] of handlers) process.off(name, callback);
      void runtime.stop().finally(() => process.kill(process.pid, signal));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
