/**
 * Node Graphiti runtime.
 *
 * Callers configure and control Graphiti through the typed lifecycle API in
 * this module. Process supervision, model routing, authentication, and
 * persistence remain internal details.
 *
 * @module
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as exec from "@dbx-tools/core/exec";
import { DurableFalkorDB } from "@dbx-tools/falkor-db";
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
  if (options.listen.scheme !== "tcp" || options.falkorListen.scheme !== "tcp") {
    throw new Error("Graphiti requires TCP listeners");
  }
  return {
    ...process.env,
    ...graphitiOptionsEnvironment(options),
    DB_BACKEND: "falkordb",
    FALKORDB_HOST: options.falkorListen.host,
    FALKORDB_PORT: String(options.falkorListen.port),
    UVICORN_HOST: options.listen.host,
    UVICORN_PORT: String(options.listen.port),
  };
}

/** Start one Graphiti runtime from the shared typed options. */
export async function startGraphitiRuntime(
  options: GraphitiRuntimeOptions = {},
): Promise<GraphitiRuntime> {
  const resolved = resolveGraphitiOptions(options);
  if (resolved.falkorListen.scheme !== "tcp") {
    throw new Error("Graphiti requires a TCP FalkorDB listener");
  }
  const database = await DurableFalkorDB.open({
    dataDir: resolved.falkorDataDir ?? join(graphitiHome(resolved), "data", "falkor-db"),
    port: resolved.falkorListen.port,
    snapshotSeconds: resolved.falkorSnapshotSeconds,
    snapshotMinChanges: resolved.falkorSnapshotMinChanges,
    redisConfig: { bind: resolved.falkorListen.host },
    persistence: { forceBackupOnShutdown: true },
    handleSignals: false,
  });
  const children: exec.ChildProcessResult[] = [];
  try {
    children.push(
      exec.spawn(
        "uv",
        [
          "run",
          "--no-project",
          "--python",
          process.env.PYTHON ?? "python3",
          "python",
          "-m",
          "uvicorn",
          "dbx_tools.graphiti.main:app",
        ],
        {
          env: _runtimeEnvironment(resolved),
        },
      ),
    );
    return managedRuntime(resolved, database, children);
  } catch (error) {
    for (const child of children) child.kill("SIGTERM");
    await Promise.allSettled(children);
    await database.close();
    throw error;
  }
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
  database: DurableFalkorDB,
  children: exec.ChildProcessResult[],
): GraphitiRuntime {
  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    closing ??= (async () => {
      for (const child of children) child.kill("SIGTERM");
      await Promise.allSettled(children);
      await database.close();
    })();
    return closing;
  };
  const result = Promise.race(
    children.map(async (child) => {
      const outcome = await child;
      if (outcome.exitCode !== 0) {
        throw new Error(`Graphiti child exited with status ${outcome.exitCode}`);
      }
    }),
  ).finally(stop);
  return { options, result, stop };
}

function graphitiHome(options: ResolvedGraphitiOptions): string {
  if (options.graphitiHome) return options.graphitiHome;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "dbx-tools", "graphiti");
  }
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "dbx-tools",
      "graphiti",
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "dbx-tools",
    "graphiti",
  );
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
