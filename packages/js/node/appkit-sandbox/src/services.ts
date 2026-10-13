import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SSH_SERVICE_LOG_DEFAULT_MAX_CHARS,
  SSH_SERVICE_LOG_DEFAULT_MAX_LINES,
  SSH_MACHINE_SERVICE_KINDS,
  type SshCommandResult,
  type SshMachineServiceKind,
  type SshMachineServiceLogsRequest,
} from "@dbx-tools/shared-databricks-sandbox";
import { parse } from "smol-toml";
import { packageScriptCommand } from "./_projects.ts";
import {
  desktopBrowserMetadata,
  desktopMiseEnvironment,
  desktopOpenUrl,
  desktopPorts,
} from "./desktop.ts";
import type { SshSession } from "./session.ts";

const TTYD_PORT = 7681;
const GLANCES_PORT = 61208;
const SERVICE_SETUP_SCRIPT = readPackageResource("scripts", "setup-service.sh");
const STATUS_INSPECTION_SCRIPT = readPackageResource("scripts", "inspect-status.sh");
const GLANCES_VIEWPORT_HEAD =
  // ============================================================================
  /*html*/ `
<style id="dbx-tools-glances-viewport">
html,body,#app{width:100%;max-width:100vw;height:100%;height:100svh;max-height:100svh;min-height:0;overflow:hidden}
body{position:fixed;inset:0;margin:0}
#app>main{display:flex;width:100%;max-width:100vw;height:100%;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.top,.bottom,.bottom>.row,.bottom .col{max-width:100%;min-width:0}
.bottom{min-height:0;flex:1;overflow:hidden}.bottom>.row{height:100%;min-height:0;margin-right:0;margin-left:0}.bottom .col{height:100%;min-height:0;padding-right:0;padding-left:0;overflow-x:hidden;overflow-y:auto}
.sidebar-min,.sidebar-max{height:100%!important;min-height:0!important}
#processlist{height:auto!important;max-width:100%;overflow:visible}
#processlist-table{width:100%;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
</style>
`
    // ============================================================================
    .trim();

/** Fixed loopback ports reserved by hidden machine service projects. */
export const sshServicePorts = {
  terminal: TTYD_PORT,
  desktop: desktopPorts.web,
  stats: GLANCES_PORT,
} as const satisfies Record<SshMachineServiceKind, number>;

/** Loopback service endpoint and routing behavior discovered after remote startup. */
export interface SshServiceTarget {
  /** Remote loopback host. */
  remoteHost: string;
  /** Remote service port. */
  remotePort: number;
  /** Whether AppKit removes the public route prefix before forwarding. */
  stripPrefix: boolean;
  /** Whether requests without a trailing slash redirect before forwarding. */
  redirectToSlash?: boolean;
  /** Optional markup injected into proxied HTML heads. */
  htmlHead?: string;
  /** AppKit URL that opens the service at its intended entry page. */
  openUrl: string;
}

/** Packaged mise configuration and browser metadata for one built-in service. */
export interface SshServiceDefinition {
  /** Built-in service identifier. */
  kind: SshMachineServiceKind;
  /** Persisted definition version used to reconcile upgrades. */
  definitionVersion: number;
  /** Remote directory that owns the service mise configuration. */
  directory: string;
  /** Packaged mise configuration installed on the Sandbox. */
  miseToml: string;
  /** Installation environment consumed by the mise postinstall hook. */
  environment: Readonly<Record<string, string>>;
  /** Loopback and browser routing metadata. */
  target: SshServiceTarget;
}

/** Remote lifecycle states read from packaged status and lock files. */
export interface SshRemoteLifecycleStates {
  services: ReadonlyMap<SshMachineServiceKind, "stopped" | "starting" | "ready" | "error">;
  serviceLogs: ReadonlyMap<SshMachineServiceKind, string>;
  projects: ReadonlyMap<string, "stopped" | "starting" | "ready" | "error">;
}

interface ServiceMetadata {
  fileName: string;
  definitionVersion: number;
  environment?: () => Readonly<Record<string, string>>;
  target: (path: string) => SshServiceTarget;
}

/**
 * Loads one packaged service definition and resolves its route-specific metadata.
 *
 * The source TOML owns installation in `hooks.postinstall` and process
 * lifecycle in hidden `tasks.start` and `tasks.stop` tasks.
 */
export function loadSshServiceDefinition(
  kind: SshMachineServiceKind,
  path: string,
): SshServiceDefinition {
  const metadata = serviceMetadata(kind);
  const miseToml = readPackageResource("src", "service-definitions", metadata.fileName);
  assertMiseServiceDefinition(kind, miseToml);
  return {
    kind,
    definitionVersion: metadata.definitionVersion,
    directory: `~/projects/.sandbox-services/${kind}`,
    miseToml,
    environment: {
      DBX_TOOLS_SERVICE_PATH: path.replace(/\/+$/, ""),
      ...metadata.environment?.(),
    },
    target: metadata.target(path),
  };
}

/**
 * Installs and starts an idempotent built-in browser service on an SSH machine.
 *
 * The packaged runner only materializes the selected mise configuration and
 * invokes its install and start lifecycle.
 *
 * @throws When the remote mise lifecycle exits unsuccessfully.
 */
export async function ensureSshService(
  session: SshSession,
  kind: SshMachineServiceKind,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
  install = true,
): Promise<SshServiceTarget> {
  const definition = loadSshServiceDefinition(kind, path);
  const result = await executeServiceTask(session, definition, "start", timeoutMs, signal, install);
  assertServiceStarted(kind, result);
  return definition.target;
}

/** Reads refresh-safe service and project lifecycle state from one active SSH session. */
export async function inspectSshLifecycleStates(
  session: SshSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshRemoteLifecycleStates> {
  const result = await session.execute(
    "sh",
    [
      "-lc",
      packageScriptCommand(STATUS_INSPECTION_SCRIPT, [
        String(SSH_SERVICE_LOG_DEFAULT_MAX_LINES),
        String(SSH_SERVICE_LOG_DEFAULT_MAX_CHARS),
      ]),
    ],
    { timeoutMs, signal },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || "Sandbox lifecycle status inspection failed");
  }
  const services = new Map<SshMachineServiceKind, "stopped" | "starting" | "ready" | "error">();
  const serviceLogs = new Map<SshMachineServiceKind, string>();
  const projects = new Map<string, "stopped" | "starting" | "ready" | "error">();
  for (const line of result.stdout.split("\n")) {
    const [category, name, value] = line.split("\t");
    if (!name || value === undefined) continue;
    if (category === "service" && isServiceKind(name) && isLifecycleState(value)) {
      services.set(name, value);
    }
    if (category === "service-log" && isServiceKind(name)) {
      serviceLogs.set(name, Buffer.from(value, "base64").toString("utf8"));
    }
    if (category === "project" && isLifecycleState(value)) projects.set(name, value);
  }
  return { services, serviceLogs, projects };
}

/** Reads the fixed lifecycle log shared by all callers of one built-in service. */
export async function readSshServiceOperationLog(
  session: SshSession,
  kind: SshMachineServiceKind,
  timeoutMs: number,
  signal?: AbortSignal,
  limits: Pick<SshMachineServiceLogsRequest, "maxLines" | "maxChars"> = {
    maxLines: SSH_SERVICE_LOG_DEFAULT_MAX_LINES,
    maxChars: SSH_SERVICE_LOG_DEFAULT_MAX_CHARS,
  },
): Promise<string> {
  const result = await session.execute(
    "sh",
    [
      "-lc",
      `log_file="$HOME/.dbx-tools/operations/services/${kind}/lifecycle.log"; if [ -f "$log_file" ]; then tail -n ${limits.maxLines} "$log_file" | tail -c ${limits.maxChars}; fi`,
    ],
    { timeoutMs, signal },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || "Sandbox service log inspection failed");
  }
  return result.stdout;
}

/** Stops one materialized built-in service through its packaged mise lifecycle. */
export async function stopSshService(
  session: SshSession,
  definition: SshServiceDefinition,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const result = await executeServiceTask(session, definition, "stop", timeoutMs, signal, false);
  assertServiceStarted(definition.kind, result);
}

/** Return a ttyd URL that starts the shell in one owned project directory. */
export function projectTerminalOpenUrl(openUrl: string, directory: string): string {
  const url = new URL(openUrl, "http://localhost");
  url.searchParams.set("arg", directory);
  return `${url.pathname}${url.search}`;
}

function serviceMetadata(kind: SshMachineServiceKind): ServiceMetadata {
  switch (kind) {
    case "terminal":
      return {
        fileName: "terminal.mise.toml",
        definitionVersion: 4,
        target: (path) => ({
          remoteHost: "127.0.0.1",
          remotePort: TTYD_PORT,
          stripPrefix: true,
          redirectToSlash: true,
          openUrl: `${path.replace(/\/+$/, "")}/`,
        }),
      };
    case "desktop":
      return {
        fileName: "desktop.mise.toml",
        definitionVersion: 11,
        environment: desktopMiseEnvironment,
        target: (path) => ({
          ...desktopBrowserMetadata,
          openUrl: desktopOpenUrl(path),
        }),
      };
    case "stats":
      return {
        fileName: "stats.mise.toml",
        definitionVersion: 2,
        target: (path) => ({
          remoteHost: "127.0.0.1",
          remotePort: GLANCES_PORT,
          stripPrefix: false,
          redirectToSlash: true,
          htmlHead: GLANCES_VIEWPORT_HEAD,
          openUrl: `${path.replace(/\/+$/, "")}/`,
        }),
      };
  }
}

function assertMiseServiceDefinition(kind: SshMachineServiceKind, source: string): void {
  const document = parse(source);
  const hooks = objectField(document, "hooks");
  const tasks = objectField(document, "tasks");
  const start = objectField(tasks, "start");
  const stop = objectField(tasks, "stop");
  if (
    typeof hooks.postinstall !== "string" ||
    typeof start.run !== "string" ||
    start.hide !== true ||
    typeof stop.run !== "string" ||
    stop.hide !== true
  ) {
    throw new Error(
      `Packaged ${kind} service must define postinstall and hidden start and stop tasks`,
    );
  }
}

function objectField(
  source: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const value = source[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Packaged service configuration is missing ${name}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertServiceStarted(kind: SshMachineServiceKind, result: SshCommandResult): void {
  if (result.success) return;
  throw new Error(
    result.stderr.trim() || result.stdout.trim() || `${kind} service exited ${result.exitCode}`,
  );
}

function executeServiceTask(
  session: SshSession,
  definition: SshServiceDefinition,
  task: "start" | "stop",
  timeoutMs: number,
  signal?: AbortSignal,
  install = true,
): Promise<SshCommandResult> {
  return session.execute(
    "sh",
    [
      "-lc",
      packageScriptCommand(SERVICE_SETUP_SCRIPT, [
        definition.kind,
        Buffer.from(definition.miseToml).toString("base64"),
        task,
        String(install),
      ]),
    ],
    {
      env: { ...definition.environment },
      timeoutMs,
      signal,
    },
  );
}

function readPackageResource(...segments: string[]): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(moduleDirectory);
  const packageRoot = basename(parent) === "lib" ? dirname(parent) : parent;
  return readFileSync(join(packageRoot, ...segments), "utf8");
}

function isLifecycleState(
  value: string | undefined,
): value is "stopped" | "starting" | "ready" | "error" {
  return value === "stopped" || value === "starting" || value === "ready" || value === "error";
}

function isServiceKind(value: string): value is SshMachineServiceKind {
  return SSH_MACHINE_SERVICE_KINDS.some((kind) => kind === value);
}
