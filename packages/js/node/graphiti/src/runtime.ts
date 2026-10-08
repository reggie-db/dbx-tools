/**
 * Node Graphiti runtime.
 *
 * Callers configure and control Graphiti through the typed lifecycle API in
 * this module. Process supervision, model routing, authentication, and
 * persistence remain internal details.
 *
 * @module
 */
import { AppKitChildProcess } from "@dbx-tools/appkit/child-process";
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
  };
}

async function _pythonArgs(options: { dev?: boolean } = {}, ...args: string[]): Promise<string[]> {
  const python = process.env.PYTHON;
  const extra = options.dev ? "[dev]" : "";
  const packageArgs = python
    ? []
    : ["--with", `dbx-tools-graphiti${extra}==${(await import("../index.ts")).PACKAGE_VERSION}`];
  return [
    "run",
    "--no-project",
    ...packageArgs,
    "--python",
    python ?? "python3",
    "python",
    ...args,
  ];
}

/** Read the Graphiti OpenAPI document without starting its database runtime. */
export async function graphitiOpenApi(): Promise<string> {
  const result = await exec.spawn("uv", await _pythonArgs({}, "-m", "dbx_tools.graphiti", "docs"), {
    check: true,
    stdout: "capture",
    stderr: "capture",
  });
  return result.stdout;
}

/** Start one Graphiti runtime from the shared typed options. */
export async function startGraphitiRuntime(
  options: GraphitiRuntimeOptions = {},
): Promise<GraphitiRuntime> {
  const resolved = resolveGraphitiOptions(options);
  const managedProcess = new AppKitChildProcess([
    "uv",
    await _pythonArgs({ dev: !resolved.databaseUrl }, "-m", "dbx_tools.graphiti"),
    {
      detached: process.platform !== "win32",
      env: _runtimeEnvironment(resolved),
    },
  ]);
  const child = managedProcess.start();
  return managedRuntime(resolved, managedProcess, child);
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
  managedProcess: AppKitChildProcess,
  child: exec.ChildProcessResult,
): GraphitiRuntime {
  let closing: Promise<void> | undefined;
  let stopping = false;
  const stop = (): Promise<void> => {
    closing ??= (async () => {
      stopping = true;
      await managedProcess.shutdown();
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
