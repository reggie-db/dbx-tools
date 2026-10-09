/**
 * Node Graphiti runtime.
 *
 * Callers configure and control Graphiti through the typed lifecycle API in
 * this module. Process supervision, model routing, authentication, and
 * persistence remain internal details.
 *
 * @module
 */
import { delimiter, dirname } from "node:path";
import {
  AppKitChildProcess,
  type AppKitChildProcessHealthCheck,
} from "@dbx-tools/appkit/child-process";
import { asyncUtils, options as sharedOptions } from "@dbx-tools/shared-core";
import {
  graphitiOptionsEnvironment,
  resolveGraphitiOptions,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "./options.ts";

/** HTTP probe used to decide that the Graphiti sidecar has started listening. */
export type GraphitiHealthCheck = AppKitChildProcessHealthCheck;

/** Shared Graphiti options plus the Node-only sidecar readiness probe. */
export type GraphitiRuntimeOptions = GraphitiOptions & {
  /** Readiness probe for {@link createGraphitiChildProcess}. Defaults to `/healthcheck`. */
  healthCheck?: GraphitiHealthCheck;
};

const HEALTH_CHECK_INTERVAL_MS = 200;

/** Shared Graphiti options accepted by runtime callers, without the Node probe. */
function graphitiOptions(options: GraphitiRuntimeOptions): GraphitiOptions {
  const { healthCheck: _healthCheck, ...graphiti } = options;
  return graphiti;
}

/** Milliseconds left in a startup budget after `startedAt`. */
export function remainingTimeoutMs(startedAt: number, timeoutMs: number, now = Date.now()): number {
  return Math.max(0, timeoutMs - (now - startedAt));
}

/** Build the private process environment from the exact shared configuration. */
function _runtimeEnvironment(options: ResolvedGraphitiOptions): NodeJS.ProcessEnv {
  if (options.listen.scheme !== "tcp") throw new Error("Graphiti requires a TCP listener");
  const nodeBin = process.env.DBX_TOOLS_NODE_BIN?.trim();
  const path = nodeBin
    ? [dirname(nodeBin), process.env.PATH].filter(Boolean).join(delimiter)
    : process.env.PATH;
  return {
    ...process.env,
    ...(path ? { PATH: path } : {}),
    ...graphitiOptionsEnvironment(options),
  };
}

/** Return whether the Graphiti `/healthcheck` endpoint responds successfully. */
export async function graphitiHealthCheck(
  options: Pick<ResolvedGraphitiOptions, "listen" | "bearer">,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    return (
      await fetch(graphitiHttpUrl(options, "/healthcheck"), {
        signal,
        headers: graphitiRequestHeaders(options),
      })
    ).ok;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

/** Poll `/healthcheck` until it succeeds or `timeoutMs` elapses. */
export async function waitForGraphitiHealth(
  options: Pick<ResolvedGraphitiOptions, "listen" | "bearer">,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const budget = Math.max(1, timeoutMs);
  for await (const healthy of asyncUtils.poll(
    ({ signal: pollSignal }) => graphitiHealthCheck(options, pollSignal),
    {
      intervalMs: HEALTH_CHECK_INTERVAL_MS,
      timeoutMs: budget,
      signal,
      predicate: (ready) => !ready,
    },
  )) {
    if (healthy) return;
  }
  throw new Error("Graphiti sidecar healthcheck did not succeed");
}

/** Build authorization headers for one optionally secured Graphiti runtime. */
export function graphitiRequestHeaders(
  options: Pick<ResolvedGraphitiOptions, "bearer">,
): Readonly<Record<string, string>> {
  return options.bearer ? { authorization: `Bearer ${options.bearer}` } : {};
}

/** Executable and arguments used to launch Graphiti. */
export interface GraphitiPythonCommand {
  command: string;
  args: string[];
}

/** Resolve direct Python when configured, otherwise a uv-provisioned runtime. */
export async function resolveGraphitiPythonCommand(
  options: { dev?: boolean } = {},
  ...args: string[]
): Promise<GraphitiPythonCommand> {
  const python = process.env.PYTHON;
  if (python) return { command: python, args };
  const extra = options.dev ? "[dev]" : "";
  const packageArgs = [
    "--with",
    `dbx-tools-graphiti${extra}==${(await import("../index.ts")).PACKAGE_VERSION}`,
  ];
  return {
    command: "uv",
    args: ["run", "--no-project", ...packageArgs, "--python", "python3", "python", ...args],
  };
}

/** Build one HTTP URL for a resolved Graphiti listener. */
export function graphitiHttpUrl(
  options: Pick<ResolvedGraphitiOptions, "listen">,
  path: string,
): string {
  return `${sharedOptions
    .formatListenAddress(options.listen)
    .replace(/^tcp:/, "http:")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Build one readiness-gated Graphiti sidecar from the shared typed options. */
export async function createGraphitiChildProcess(
  options: GraphitiRuntimeOptions = {},
): Promise<AppKitChildProcess> {
  const healthCheck = options.healthCheck;
  const resolved = resolveGraphitiOptions(graphitiOptions(options));
  const python = await resolveGraphitiPythonCommand(
    { dev: !resolved.databaseUrl },
    "-m",
    "dbx_tools.graphiti",
  );
  return new AppKitChildProcess(
    [
      python.command,
      python.args,
      {
        env: _runtimeEnvironment(resolved),
      },
    ],
    {
      healthCheck: healthCheck ?? (({ signal }) => graphitiHealthCheck(resolved, signal)),
      healthCheckTimeoutMs: resolved.startupTimeoutMs,
    },
  );
}

/** Run the supervised stack until one child exits or the process is signaled. */
export async function runGraphiti(options: GraphitiRuntimeOptions = {}): Promise<void> {
  const sidecar = await createGraphitiChildProcess(options);
  const outcome = await sidecar.run({ signals: ["SIGINT", "SIGTERM"] });
  if (outcome.exitCode !== 0) {
    throw new Error(`Graphiti child exited with status ${outcome.exitCode}`);
  }
}
