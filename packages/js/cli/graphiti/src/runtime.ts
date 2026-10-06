/**
 * Node-owned Graphiti process supervision.
 *
 * This module starts the durable embedded FalkorDB owner, the optional model
 * gateway, and the pinned Python MCP adapter. Python owns only Graphiti-specific
 * adaptation over the bundled upstream source.
 *
 * @module
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveServicePackageBin } from "@dbx-tools/cli-service/definition";
import * as exec from "@dbx-tools/core/exec";
import { DurableFalkorDB } from "@dbx-tools/falkor-db";
import {
  GRAPHITI_OPTIONS_ENV,
  resolveGraphitiOptions,
  serializeGraphitiOptions,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import { GRAPHITI_PYTHON_VERSION } from "./_python-runtime.ts";

const FALKORDB_SOCKET_ENV = "FALKORDB_SOCKET_PATH";

type ExecPython = (file: string, args: string[]) => Promise<unknown>;

/** Shared Graphiti options plus upstream arguments accepted by runtime callers. */
export type GraphitiRuntimeOptions = GraphitiOptions;

/** Running Graphiti stack controlled by one Node process. */
export interface GraphitiRuntime {
  /** Fully defaulted runtime configuration. */
  readonly options: ResolvedGraphitiOptions;
  /** Resolves when a supervised process exits, after all siblings are stopped. */
  readonly result: Promise<void>;
  /** Stop child processes and close FalkorDB without an implicit save. */
  close(): Promise<void>;
}

/** Install the matching Python adapter through the configured Python registry. */
export async function ensureGraphitiPython(
  python: string,
  run: ExecPython = (file, args) =>
    exec.spawn(file, args, {
      stdout: "capture",
      stderr: "capture",
      check: true,
    }),
): Promise<void> {
  try {
    await run(python, [
      "-c",
      `import importlib.metadata; assert importlib.metadata.version('dbx-tools-graphiti') == '${GRAPHITI_PYTHON_VERSION}'`,
    ]);
    return;
  } catch {
    await run(python, ["-m", "pip", "--version"]);
    await run(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--upgrade",
      "--user",
      "--break-system-packages",
      `dbx-tools-graphiti==${GRAPHITI_PYTHON_VERSION}`,
    ]);
  }
}

/** Resolve the foreground model-gateway command using the service package owner. */
export function ensureGraphitiModelGateway(
  executable: () => string = () => resolveServicePackageBin("@dbx-tools/cli-model-gateway"),
): string {
  return [process.execPath, resolve(executable())].map(shellQuote).join(" ");
}

/** Build the environment consumed by the Python MCP adapter. */
export function graphitiRuntimeEnvironment(
  options: GraphitiRuntimeOptions,
  socketPath: string,
): NodeJS.ProcessEnv {
  const resolved = resolveGraphitiOptions({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  return {
    ...process.env,
    [FALKORDB_SOCKET_ENV]: socketPath,
    [GRAPHITI_OPTIONS_ENV]: serializeGraphitiOptions(resolved),
  };
}

/** Start FalkorDB, the optional model gateway, and the Python MCP adapter. */
export async function startGraphitiRuntime(
  options: GraphitiRuntimeOptions = {},
): Promise<GraphitiRuntime> {
  const resolved = resolveGraphitiOptions({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  await ensureGraphitiPython(resolved.python);
  const database = await DurableFalkorDB.open({
    dataDir: resolved.falkorDataDir ?? join(graphitiHome(resolved), "data", "falkor-db"),
    snapshotSeconds: resolved.falkorSnapshotSeconds,
    snapshotMinChanges: resolved.falkorSnapshotMinChanges,
    persistence: { forceBackupOnShutdown: true },
    handleSignals: false,
  });
  const children: exec.ChildProcessResult[] = [];
  try {
    if (resolved.manageModelGateway) {
      const command = [
        resolved.modelGatewayCommand!,
        ...(resolved.profile ? ["--profile", shellQuote(resolved.profile)] : []),
        "--listen",
        shellQuote(`${resolved.modelGatewayHost}:${resolved.modelGatewayPort}`),
      ].join(" ");
      children.push(exec.spawn(command, [], { shell: true }));
    }
    children.push(
      exec.spawn(resolved.python, ["-m", "dbx_tools.graphiti", ...resolved.graphitiArgs], {
        env: graphitiRuntimeEnvironment(resolved, database.socketPath),
      }),
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
  const close = (): Promise<void> => {
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
  ).finally(close);
  return { options, result, close };
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
      void runtime.close().finally(() => process.kill(process.pid, signal));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
