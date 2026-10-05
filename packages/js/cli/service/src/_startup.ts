import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ServicePaths, ServiceRuntimeContext } from "./_paths.ts";
import type { CliServiceDefinition } from "./definition.ts";

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
}

export async function removeStartup(paths: ServicePaths): Promise<void> {
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
