/**
 * Native per-user service installation for the token broker.
 *
 * @module
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { exec } from "@dbx-tools/core";

import { safeName } from "./_name.ts";

export type ServiceAction = "install" | "remove" | "start" | "status" | "stop";

/** Runtime command and stable paths rendered into an OS-native user service. */
export interface ServiceSpec {
  /** Service-manager identifier. */
  name: string;
  /** Human-readable service description. */
  description: string;
  /** Absolute runtime executable. */
  command: string;
  /** Arguments passed without shell interpretation. */
  args: string[];
  /** Stable service working directory. */
  workingDirectory: string;
  /** Broker-owned state and log directory. */
  stateDirectory: string;
}

/** Normalized service state returned by every platform adapter. */
export interface ServiceResult {
  /** Whether the native definition exists and is enabled. */
  installed: boolean;
  /** Whether the service manager reports an active process. */
  running: boolean;
  /** Trimmed native status output for diagnostics. */
  detail: string;
}

/** Injectable platform boundaries for deterministic lifecycle tests. */
export interface ManageServiceOptions {
  execute?: typeof exec.spawn;
  home?: string;
  platform?: NodeJS.Platform;
  uid?: number;
}

/**
 * Install, remove, start, stop, or inspect the current user's native service.
 *
 * This never requires administrator privileges: launchd LaunchAgents, systemd
 * user units, and per-user Task Scheduler entries are used.
 */
export async function manageService(
  action: ServiceAction,
  spec: ServiceSpec,
  options: ManageServiceOptions = {},
): Promise<ServiceResult> {
  const execute = options.execute ?? exec.spawn;
  const home = options.home ?? homedir();
  switch (options.platform ?? process.platform) {
    case "darwin":
      return manageLaunchd(action, spec, execute, home, options.uid ?? process.getuid?.() ?? 0);
    case "linux":
      return manageSystemd(action, spec, execute, home);
    case "win32":
      return manageWindowsTask(action, spec, execute);
    default:
      throw new Error(`Token broker services are not supported on ${process.platform}`);
  }
}

async function manageLaunchd(
  action: ServiceAction,
  spec: ServiceSpec,
  execute: typeof exec.spawn,
  home: string,
  uid: number,
): Promise<ServiceResult> {
  const label = `com.dbx-tools.${safeName(spec.name, "Service")}`;
  const path = resolve(home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${uid}`;
  if (action === "install") {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(spec.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path, renderLaunchdPlist(label, spec), "utf8");
    await command(execute, "launchctl", ["bootout", domain, path], false);
    await command(execute, "launchctl", ["bootstrap", domain, path]);
  } else if (action === "remove") {
    await command(execute, "launchctl", ["bootout", domain, path], false);
    await rm(path, { force: true });
  } else if (action === "start") {
    await command(execute, "launchctl", ["kickstart", `${domain}/${label}`]);
  } else if (action === "stop") {
    await command(execute, "launchctl", ["kill", "SIGTERM", `${domain}/${label}`], false);
  }
  const status = await command(execute, "launchctl", ["print", `${domain}/${label}`], false);
  return result(status.exitCode === 0, status.exitCode === 0, status.stdout || status.stderr);
}

async function manageSystemd(
  action: ServiceAction,
  spec: ServiceSpec,
  execute: typeof exec.spawn,
  home: string,
): Promise<ServiceResult> {
  const unit = `${safeName(spec.name, "Service")}.service`;
  const path = resolve(home, ".config", "systemd", "user", unit);
  if (action === "install") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderSystemdUnit(spec), "utf8");
    await command(execute, "systemctl", ["--user", "daemon-reload"]);
    await command(execute, "systemctl", ["--user", "enable", "--now", unit]);
  } else if (action === "remove") {
    await command(execute, "systemctl", ["--user", "disable", "--now", unit], false);
    await rm(path, { force: true });
    await command(execute, "systemctl", ["--user", "daemon-reload"]);
  } else {
    const verb = action === "status" ? "is-active" : action;
    await command(execute, "systemctl", ["--user", verb, unit], action !== "status");
  }
  const status = await command(execute, "systemctl", ["--user", "is-active", unit], false);
  const installed = await command(execute, "systemctl", ["--user", "is-enabled", unit], false);
  return result(installed.exitCode === 0, status.exitCode === 0, status.stdout || status.stderr);
}

async function manageWindowsTask(
  action: ServiceAction,
  spec: ServiceSpec,
  execute: typeof exec.spawn,
): Promise<ServiceResult> {
  const name = safeName(spec.name, "Service");
  if (action === "install") {
    const taskCommand = renderWindowsCommand(spec.command, spec.args);
    await command(execute, "schtasks", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      name,
      "/TR",
      taskCommand,
    ]);
    await command(execute, "schtasks", ["/Run", "/TN", name]);
  } else if (action === "remove") {
    await command(execute, "schtasks", ["/Delete", "/F", "/TN", name], false);
  } else if (action === "start") {
    await command(execute, "schtasks", ["/Run", "/TN", name]);
  } else if (action === "stop") {
    await command(execute, "schtasks", ["/End", "/TN", name], false);
  }
  const status = await command(execute, "schtasks", ["/Query", "/TN", name, "/FO", "LIST"], false);
  return result(
    status.exitCode === 0,
    /running/i.test(status.stdout),
    status.stdout || status.stderr,
  );
}

/** Render a launchd LaunchAgent plist from the common service specification. */
export function renderLaunchdPlist(label: string, spec: ServiceSpec): string {
  const args = [spec.command, ...spec.args]
    .map((value) => `      <string>${xml(value)}</string>`)
    .join("\n");
  const log = resolve(spec.stateDirectory, "service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${xml(log)}</string>
    <key>StandardErrorPath</key><string>${xml(log)}</string>
  </dict>
</plist>
`;
}

/** Render a systemd user unit from the common service specification. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=${spec.description}

[Service]
Type=simple
WorkingDirectory=${systemdEscape(spec.workingDirectory)}
ExecStart=${[spec.command, ...spec.args].map(systemdEscape).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function command(execute: typeof exec.spawn, program: string, args: string[], check = true) {
  return execute(program, args, {
    stdout: "capture",
    stderr: "capture",
    check,
  });
}

function result(installed: boolean, running: boolean, detail: string): ServiceResult {
  return { installed, running, detail: detail.trim() };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function systemdEscape(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Quote an executable and arguments for Task Scheduler's command field. */
export function renderWindowsCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((value) => `"${value.replaceAll('"', '""')}"`).join(" ");
}
