/**
 * Lazy installation and transparent execution of Rust release binaries.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";

import { bin } from "@dbx-tools/core";
import { RUST_RELEASE_BINARY_COMMANDS } from "./_rust-release-binaries.ts";

/** One release archive available to the current Node runtime. */
export interface RustReleaseBinaryAsset {
  readonly os: string;
  readonly cpu: string;
  readonly name: string;
}

/** Generated registration for one `dbx` Rust command. */
export interface RustReleaseBinaryCommand {
  readonly command: string;
  readonly description: string;
  readonly binaryName: string;
  readonly repository: string;
  readonly assets: readonly RustReleaseBinaryAsset[];
}

/** Overrides used by tests and callers that install under a custom home. */
export interface RustReleaseBinaryOptions {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly version?: string;
}

/** Return every Rust command registered by the synthesized workspace. */
export function rustReleaseBinaryCommands(): readonly RustReleaseBinaryCommand[] {
  return RUST_RELEASE_BINARY_COMMANDS;
}

/** Resolve one registered Rust command by its `dbx` subcommand. */
export function rustReleaseBinaryCommand(command: string): RustReleaseBinaryCommand {
  const resolved = RUST_RELEASE_BINARY_COMMANDS.find((candidate) => candidate.command === command);
  if (!resolved) throw new Error(`Unknown Rust release command: ${command}`);
  return resolved;
}

function repositoryName(repository: string): string {
  const parsed = new URL(repository.replace(/^git\+/, ""));
  const name = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (parsed.hostname !== "github.com" || name.split("/").length !== 2) {
    throw new Error(`Rust release repository must be a GitHub owner/repository: ${repository}`);
  }
  return name;
}

async function packageVersion(): Promise<string> {
  return (await import("../index.ts")).PACKAGE_VERSION;
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
export function rustReleaseBinaryAsset(
  command: RustReleaseBinaryCommand,
  platform: NodeJS.Platform,
  arch: string,
): RustReleaseBinaryAsset {
  const asset = command.assets.find(
    (candidate) => candidate.os === platform && candidate.cpu === arch,
  );
  if (!asset) {
    throw new Error(`${command.command} has no release binary for ${platform}/${arch}`);
  }
  return asset;
}

/** Build the GitHub release URL for a generated archive entry. */
export function rustReleaseBinaryUrl(
  command: RustReleaseBinaryCommand,
  asset: RustReleaseBinaryAsset,
  version: string,
): string {
  return `https://github.com/${repositoryName(command.repository)}/releases/download/v${version}/${asset.name}`;
}

/** Install the release binary matching this CLI version and host platform. */
export async function ensureRustReleaseBinary(
  command: RustReleaseBinaryCommand,
  options: RustReleaseBinaryOptions = {},
): Promise<bin.BinContext> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = options.version ?? (await packageVersion());
  const asset = rustReleaseBinaryAsset(command, platform, arch);
  const root = join(options.homeDir ?? homedir(), ".dbx-tools");
  const binDir = join(root, "bin");
  const destination: bin.BinContext = {
    root,
    binDir,
    path: join(binDir, versionedBinaryName(command.binaryName, version, platform)),
  };
  return bin.ensure(command.binaryName, () => rustReleaseBinaryUrl(command, asset, version), {
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

/** Install and run a Rust command with inherited terminal I/O. */
export async function runRustReleaseBinary(
  command: RustReleaseBinaryCommand,
  args: readonly string[],
  options: RustReleaseBinaryOptions = {},
): Promise<number> {
  const installed = await ensureRustReleaseBinary(command, options);
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
