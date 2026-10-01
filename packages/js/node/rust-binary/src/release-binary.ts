/**
 * Lazy installation and transparent execution of native release binaries.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";

import { bin } from "@dbx-tools/core";
import { RELEASE_BINARY_COMMANDS } from "./_release-binaries.ts";

/** One release archive available to the current Node runtime. */
export interface ReleaseBinaryAsset {
  readonly os: string;
  readonly cpu: string;
  readonly name: string;
}

/** Generated registration for one native `dbx` command. */
export interface ReleaseBinaryCommand {
  readonly command: string;
  readonly description: string;
  readonly binaryName: string;
  readonly unit: string;
  readonly component: string;
  readonly version: string;
  readonly tag: string;
  readonly repository: string;
  readonly assets: readonly ReleaseBinaryAsset[];
}

/** Overrides used by tests and callers that install under a custom home. */
export interface ReleaseBinaryOptions {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly version?: string;
}

/** Return every native command registered by the synthesized workspace. */
export function releaseBinaryCommands(): readonly ReleaseBinaryCommand[] {
  return RELEASE_BINARY_COMMANDS;
}

/** Resolve one registered native command by its `dbx` subcommand. */
export function releaseBinaryCommand(command: string): ReleaseBinaryCommand {
  const resolved = RELEASE_BINARY_COMMANDS.find((candidate) => candidate.command === command);
  if (!resolved) throw new Error(`Unknown native release command: ${command}`);
  return resolved;
}

function repositoryName(repository: string): string {
  const parsed = new URL(repository.replace(/^git\+/, ""));
  const name = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (parsed.hostname !== "github.com" || name.split("/").length !== 2) {
    throw new Error(`Release repository must be a GitHub owner/repository: ${repository}`);
  }
  return name;
}

function versionedBinaryName(
  binaryName: string,
  version: string,
  platform: NodeJS.Platform,
): string {
  const suffix = version.replace(/[^0-9A-Za-z]+/g, "_");
  const extension = platform === "win32" ? ".exe" : "";
  return `${binaryName}_${suffix}${extension}`;
}

/** Select the archive for an OS and CPU pair. */
export function releaseBinaryAsset(
  command: ReleaseBinaryCommand,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseBinaryAsset {
  const asset = command.assets.find(
    (candidate) => candidate.os === platform && candidate.cpu === arch,
  );
  if (!asset) {
    throw new Error(`${command.command} has no release binary for ${platform}/${arch}`);
  }
  return asset;
}

/** Build the GitHub release URL for a generated archive entry. */
export function releaseBinaryUrl(
  command: ReleaseBinaryCommand,
  asset: ReleaseBinaryAsset,
  version = command.version,
): string {
  const tag = version === command.version ? command.tag : `${command.component}-v${version}`;
  return `https://github.com/${repositoryName(command.repository)}/releases/download/${tag}/${asset.name}`;
}

/** Install the registered binary release matching the host platform. */
export async function ensureReleaseBinary(
  command: ReleaseBinaryCommand,
  options: ReleaseBinaryOptions = {},
): Promise<bin.BinContext> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = options.version ?? command.version;
  const asset = releaseBinaryAsset(command, platform, arch);
  const root = join(options.homeDir ?? homedir(), ".dbx-tools");
  const binDir = join(root, "bin");
  const destination: bin.BinContext = {
    root,
    binDir,
    path: join(binDir, versionedBinaryName(command.binaryName, version, platform)),
  };
  return bin.ensure(command.binaryName, () => releaseBinaryUrl(command, asset, version), {
    autoUnpackage: true,
    destination,
    minVersion: version,
    versionParser: (output) => {
      const installed = bin.parseVersion(output);
      return installed === version ? installed : undefined;
    },
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0);
}

/** Install and run a native command with inherited terminal I/O. */
export async function runReleaseBinary(
  command: ReleaseBinaryCommand,
  args: readonly string[],
  options: ReleaseBinaryOptions = {},
): Promise<number> {
  const installed = await ensureReleaseBinary(command, options);
  const child = spawn(installed.path, args, { stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve(signal ? signalExitCode(signal) : (code ?? 1));
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
