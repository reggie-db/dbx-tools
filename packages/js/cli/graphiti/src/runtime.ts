/**
 * Graphiti Python bootstrap and internal runtime execution.
 *
 * This module owns exact-version Python installation, model-gateway command
 * resolution, and the serialized boundary into Python. Public command parsing
 * belongs to `cli.ts`; Graphiti defaults and validation belong to
 * `@dbx-tools/shared-graphiti`.
 *
 * @module
 */
import { resolve } from "node:path";
import { resolveServicePackageBin } from "@dbx-tools/cli-service/definition";
import * as exec from "@dbx-tools/core/exec";
import {
  GRAPHITI_COMMAND_ENV,
  GRAPHITI_OPTIONS_ENV,
  resolveGraphitiOptions,
  serializeGraphitiOptions,
  type GraphitiCommand,
  type GraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import { GRAPHITI_PYTHON_VERSION } from "./_python-runtime.ts";

type ExecPython = (file: string, args: string[]) => Promise<unknown>;

/** Shared Graphiti options plus upstream arguments accepted by runtime callers. */
export type GraphitiRuntimeOptions = GraphitiOptions;

/** Install the matching Python runtime through the configured Python registry. */
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
  return [process.execPath, resolve(executable())]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

/** Build the environment consumed by the internal Python runtime. */
export function graphitiRuntimeEnvironment(
  command: GraphitiCommand,
  options: GraphitiRuntimeOptions = {},
): NodeJS.ProcessEnv {
  const resolved = resolveGraphitiOptions({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  return {
    ...process.env,
    [GRAPHITI_COMMAND_ENV]: command,
    [GRAPHITI_OPTIONS_ENV]: serializeGraphitiOptions(resolved),
  };
}

/** Run one internal Python Graphiti operation and preserve its exit status. */
export async function runGraphiti(
  command: GraphitiCommand,
  options: GraphitiRuntimeOptions = {},
): Promise<void> {
  const resolved = resolveGraphitiOptions(options);
  await ensureGraphitiPython(resolved.python);
  const child = exec.spawn(resolved.python, ["-m", "dbx_tools.graphiti"], {
    env: graphitiRuntimeEnvironment(command, resolved),
  });
  const terminate = () => child.kill("SIGTERM");
  const interrupt = () => child.kill("SIGINT");
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
  try {
    process.exitCode = (await child).exitCode;
  } finally {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", interrupt);
  }
}

/** Start Graphiti in the foreground. */
export async function startGraphiti(options: GraphitiRuntimeOptions = {}): Promise<void> {
  await runGraphiti("start", options);
}
