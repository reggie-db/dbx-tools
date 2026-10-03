/**
 * Lazy installation and transparent execution of native release binaries.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { bin, exec } from "@dbx-tools/core";
import { json, object, stringUtils } from "@dbx-tools/shared-core";
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
  readonly hidden: boolean;
  readonly unit: string;
  readonly component: string;
  readonly version: string;
  readonly tagPrefix: string;
  readonly tag: string;
  readonly repository: string;
  /** Cargo package name used when a GitHub archive is unavailable. */
  readonly crateName: string;
  /** Cargo features required to build this binary, empty for the default target. */
  readonly cargoFeatures: readonly string[];
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
  return RELEASE_BINARY_COMMANDS.filter((command) => !command.hidden);
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
  const tag = releaseBinaryTag(command, version);
  return `https://github.com/${repositoryName(command.repository)}/releases/download/${tag}/${asset.name}`;
}

function releaseBinaryTag(command: ReleaseBinaryCommand, version: string): string {
  return version === command.version ? command.tag : `${command.tagPrefix}${version}`;
}

/** Probe GitHub for the archive without downloading it. HEAD is preferred. */
async function githubReleaseAvailable(url: string): Promise<boolean> {
  const headers = {
    "user-agent": "@dbx-tools/rust-binary",
  };
  try {
    const head = await fetch(url, { method: "HEAD", headers, redirect: "follow" });
    if (head.status === 405 || head.status === 501) {
      const ranged = await fetch(url, {
        method: "GET",
        headers: { ...headers, range: "bytes=0-0" },
        redirect: "follow",
      });
      return ranged.ok;
    }
    return head.ok;
  } catch {
    return false;
  }
}

/** `cargo install` argv targeting a private `--root` under the ensure temp directory. */
function cargoInstallArgs(command: ReleaseBinaryCommand, version: string, root: string): string[] {
  const args = [
    "install",
    command.crateName,
    "--version",
    version,
    "--root",
    root,
    "--bin",
    command.binaryName,
    "--force",
  ];
  if (command.cargoFeatures.length > 0) {
    args.push("--features", command.cargoFeatures.join(","));
  }
  return args;
}

/** Install the exact crate version into `tempDir/cargo` and return a `file://` source. */
async function cargoInstallSource(
  command: ReleaseBinaryCommand,
  version: string,
  tempDir: string,
): Promise<bin.BinSource> {
  const probe = exec.spawnSync("cargo", ["--version"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) {
    throw new Error(`cargo is not available; cannot install ${command.binaryName}@${version}`);
  }
  const root = join(tempDir, "cargo");
  const args = cargoInstallArgs(command, version, root);
  const result = await exec.spawn("cargo", args, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    check: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cargo install ${command.crateName}@${version} failed (exit ${result.exitCode})`,
    );
  }
  const extension = process.platform === "win32" ? ".exe" : "";
  const installed = join(root, "bin", `${command.binaryName}${extension}`);
  return { url: pathToFileURL(installed).href };
}

/** Prefer a GitHub release archive; fall back to `cargo install --version`. */
async function releaseBinarySource(
  command: ReleaseBinaryCommand,
  asset: ReleaseBinaryAsset,
  version: string,
  tempDir: string,
): Promise<bin.BinSource> {
  const github = await githubReleaseSource(command, asset, version);
  if (await githubReleaseAvailable(github.url)) return github;
  return cargoInstallSource(command, version, tempDir);
}

/** GitHub archive URL plus a SHA-256 digest when the release API exposes one. */
async function githubReleaseSource(
  command: ReleaseBinaryCommand,
  asset: ReleaseBinaryAsset,
  version: string,
): Promise<bin.BinSource> {
  const url = releaseBinaryUrl(command, asset, version);
  const repository = repositoryName(command.repository);
  const tag = releaseBinaryTag(command, version);
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "@dbx-tools/rust-binary",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
  } catch {
    return { url };
  }
  if (!response.ok) return { url };
  const release = json.parseRecord(await response.text());
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const candidate = assets.find(
    (entry): entry is Record<string, unknown> =>
      object.isRecord(entry) && entry.name === asset.name,
  );
  const digest = stringUtils.trimToNull(candidate?.digest);
  const sha256 = digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  return sha256 ? { url, sha256 } : { url };
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
  return bin.ensure(
    command.binaryName,
    ({ tempDir }) => releaseBinarySource(command, asset, version, tempDir),
    {
      autoUnpackage: true,
      destination,
      minVersion: version,
      versionParser: (output) => {
        const installed = bin.parseVersion(output);
        return installed === version ? installed : undefined;
      },
    },
  );
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
