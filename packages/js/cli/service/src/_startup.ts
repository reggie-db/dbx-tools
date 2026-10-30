import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { spawn } from "@dbx-tools/core";
import { sleep } from "@dbx-tools/shared-core";

import type { ServicePaths, ServiceRuntimeContext } from "./_paths.ts";
import type { CliServiceDefinition } from "./definition.ts";

const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 40;
const LAUNCH_AGENT_STATE_TIMEOUT_MILLISECONDS = 45_000;
const LAUNCH_AGENT_POLL_INTERVAL_MILLISECONDS = 100;

export interface ServiceLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export async function installStartup(
  definition: CliServiceDefinition,
  paths: ServicePaths,
  runtime: ServiceRuntimeContext,
  launch: ServiceLaunch,
): Promise<void> {
  await mkdir(dirname(paths.startupFile), { recursive: true });
  const content =
    runtime.platform === "darwin"
      ? renderLaunchAgent(definition, launch)
      : runtime.platform === "win32"
        ? renderWindowsStartup(launch)
        : renderDesktopEntry(definition, launch);
  await writeFile(paths.startupFile, content, {
    encoding: "utf8",
    mode: runtime.platform === "win32" ? undefined : 0o644,
  });
  if (runtime.platform === "darwin") {
    await unloadLaunchAgent(definition, runtime);
    await runLaunchctl(["enable", launchAgentTarget(definition, runtime)], runtime, true);
  }
}

export async function startStartup(
  definition: CliServiceDefinition,
  paths: ServicePaths,
  runtime: ServiceRuntimeContext,
  launch: ServiceLaunch,
): Promise<ChildProcess | undefined> {
  if (runtime.platform === "darwin") {
    const target = launchAgentTarget(definition, runtime);
    if (await launchAgentLoaded(definition, runtime)) {
      await runLaunchctl(["kickstart", "-k", target], runtime, true);
    } else {
      await runLaunchctl(
        ["bootstrap", launchAgentDomain(runtime), paths.startupFile],
        runtime,
        true,
      );
    }
    return undefined;
  }
  const child = spawnChild(launch.executable, launch.arguments, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

export async function stopStartup(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
): Promise<void> {
  if (runtime.platform === "darwin") await unloadLaunchAgent(definition, runtime);
}

export async function removeStartup(
  definition: CliServiceDefinition,
  paths: ServicePaths,
  runtime: ServiceRuntimeContext,
): Promise<void> {
  await stopStartup(definition, runtime);
  await rm(paths.startupFile, { force: true });
}

export function renderLaunchAgent(definition: CliServiceDefinition, launch: ServiceLaunch): string {
  const argumentsXml = [launch.executable, ...launch.arguments]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${escapeXml(definition.id)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argumentsXml,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>ExitTimeOut</key>",
    `    <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>`,
    "    <key>ProcessType</key>",
    "    <string>Interactive</string>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function renderDesktopEntry(
  definition: CliServiceDefinition,
  launch: ServiceLaunch,
): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopValue(definition.name)}`,
    `Exec=${[launch.executable, ...launch.arguments].map(quoteDesktopArgument).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function renderWindowsStartup(launch: ServiceLaunch): string {
  const command = [launch.executable, ...launch.arguments].map(quoteWindowsArgument).join(" ");
  return `@echo off\r\nstart "" /b ${command}\r\n`;
}

async function unloadLaunchAgent(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
): Promise<void> {
  if (!(await launchAgentLoaded(definition, runtime))) return;
  await runLaunchctl(["bootout", launchAgentTarget(definition, runtime)], runtime, true);
  await waitForLaunchAgentState(definition, runtime, false);
}

async function waitForLaunchAgentState(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
  loaded: boolean,
): Promise<void> {
  const deadline = Date.now() + LAUNCH_AGENT_STATE_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if ((await launchAgentLoaded(definition, runtime)) === loaded) return;
    await sleep(LAUNCH_AGENT_POLL_INTERVAL_MILLISECONDS);
  }
  throw new Error(`${definition.name} LaunchAgent did not ${loaded ? "load" : "unload"}`);
}

async function launchAgentLoaded(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
): Promise<boolean> {
  const result = await runLaunchctl(
    ["print", launchAgentTarget(definition, runtime)],
    runtime,
    false,
  );
  return result.exitCode === 0;
}

function launchAgentDomain(runtime: ServiceRuntimeContext): string {
  const userId = runtime.userId;
  if (userId === undefined) throw new Error("macOS service installation requires a user ID");
  return `gui/${userId}`;
}

function launchAgentTarget(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
): string {
  return `${launchAgentDomain(runtime)}/${definition.id}`;
}

function runLaunchctl(
  arguments_: readonly string[],
  runtime: ServiceRuntimeContext,
  check: boolean,
) {
  return spawn("launchctl", [...arguments_], {
    check,
    env: runtime.environment,
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
  });
}

function escapeDesktopValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteDesktopArgument(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")}"`;
}

function quoteWindowsArgument(value: string): string {
  const escapedPercent = value.replaceAll("%", "%%");
  const escapedQuotes = escapedPercent.replace(/(\\*)"/g, '$1$1\\"');
  const escapedTrailingSlashes = escapedQuotes.replace(/(\\+)$/, "$1$1");
  return `"${escapedTrailingSlashes}"`;
}
