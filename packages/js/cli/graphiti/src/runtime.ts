/**
 * Graphiti runtime bootstrap and foreground execution for CLI and AppKit callers.
 *
 * This module owns exact-version Python installation and model-gateway command
 * resolution. Reuse it instead of adding installers or package-bin discovery to
 * AppKit plugins. Python owns Graphiti, Neo4j, and their process supervision;
 * `@dbx-tools/cli-service` owns desktop installation and lifecycle.
 *
 * @module
 */
import { resolve } from "node:path";
import { resolveServicePackageBin } from "@dbx-tools/cli-service/definition";
import * as exec from "@dbx-tools/core/exec";
import { GRAPHITI_PYTHON_VERSION } from "./_python-runtime.ts";

type ExecPython = (file: string, args: string[]) => Promise<unknown>;

/** Python executable, selected profile, and Python-owned foreground arguments. */
export interface GraphitiRuntimeOptions {
  /** Python executable used to bootstrap and start the matching runtime. */
  readonly python?: string;
  /** Explicit Databricks profile forwarded to Python. */
  readonly profile?: string;
  /** Additional arguments forwarded unchanged to Python's start command. */
  readonly args?: readonly string[];
}

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

/** Start Python's Graphiti stack, forwarding termination and its exit status. */
export async function startGraphiti(options: GraphitiRuntimeOptions = {}): Promise<void> {
  const python = options.python ?? process.env.PYTHON ?? "python3";
  await ensureGraphitiPython(python);
  const child = exec.spawn(
    python,
    [
      "-m",
      "dbx_tools.graphiti",
      "start",
      ...(options.profile ? ["--profile", options.profile] : []),
      ...(options.args ?? []),
    ],
    {
      env: {
        ...process.env,
        MANAGE_MODEL_GATEWAY: process.env.MANAGE_MODEL_GATEWAY ?? "true",
        MODEL_GATEWAY_COMMAND: process.env.MODEL_GATEWAY_COMMAND ?? ensureGraphitiModelGateway(),
      },
    },
  );
  const terminate = () => {
    child.kill("SIGTERM");
  };
  const interrupt = () => {
    child.kill("SIGINT");
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
  try {
    process.exitCode = (await child).exitCode;
  } finally {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", interrupt);
  }
}
