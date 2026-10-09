/**
 * Ensures Monty's platform native package is present before the Node addon loads.
 *
 * `@pydantic/monty` ships `@pydantic/monty-<platform>` as optionalDependencies.
 * npm can skip those (https://github.com/npm/cli/issues/4828), which surfaces as
 * "Cannot find native binding". This module installs only the current platform
 * package, at the already-installed `@pydantic/monty` version, without rewriting
 * package.json.
 *
 * @module
 */

import { createRequire } from "node:module";
import { COMMAND_NOT_FOUND_EXIT_CODE, exec } from "@dbx-tools/core";
import { errorUtils, log } from "@dbx-tools/shared-core";

const logger = log.logger("mastra/monty-native");
const requireFromHere = createRequire(import.meta.url);

/** Result of spawning the package installer. */
export interface MontyNativeInstallResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Installer used by {@link ensureMontyNativeBinding}. */
export type MontyNativeInstaller = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<MontyNativeInstallResult>;

/** Overrides for {@link ensureMontyNativeBinding} (tests inject resolve/install). */
export interface EnsureMontyNativeBindingOptions {
  /** Working directory for the in-place install. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Module resolver; defaults to `createRequire(import.meta.url).resolve`. */
  resolve?: (specifier: string) => string;
  /** Package installer; defaults to npm, then bun when npm is missing. */
  install?: MontyNativeInstaller;
}

/**
 * npm package that ships Monty's `.node` addon and `monty` binary for this
 * process. Matches `@pydantic/monty`'s `platformTriple()` / optionalDependencies.
 */
export function montyNativeBindingPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return `@pydantic/monty-darwin-${arch}`;
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return `@pydantic/monty-linux-${arch}-gnu`;
  }
  if (platform === "win32" && arch === "x64") {
    return "@pydantic/monty-win32-x64-msvc";
  }
  return undefined;
}

/**
 * Resolve the current platform's Monty native package, installing it in place
 * when npm omitted the optional dependency.
 */
export async function ensureMontyNativeBinding(
  options: EnsureMontyNativeBindingOptions = {},
): Promise<void> {
  const pkg = montyNativeBindingPackage();
  if (!pkg) return;

  const resolve = options.resolve ?? ((specifier: string) => requireFromHere.resolve(specifier));
  if (isResolvable(pkg, resolve)) return;

  const version = montyPackageVersion(resolve);
  const spec = `${pkg}@${version}`;
  const cwd = options.cwd ?? process.cwd();
  logger.warn("native-binding:missing", { package: spec, cwd });

  const install = options.install ?? defaultInstaller;
  const output = await installNativePackage(spec, cwd, install);
  if (!isResolvable(pkg, resolve)) {
    throw new Error(
      `Monty native binding ${spec} is still missing after ${output.command}. ${output.detail}`,
    );
  }
  logger.info("native-binding:installed", { package: spec, command: output.command });
}

function isResolvable(specifier: string, resolve: (specifier: string) => string): boolean {
  try {
    resolve(`${specifier}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function montyPackageVersion(resolve: (specifier: string) => string): string {
  const pkg = requireFromHere(resolve("@pydantic/monty/package.json")) as { version?: string };
  const version = pkg.version?.trim();
  if (!version) throw new Error("Installed @pydantic/monty has no version");
  return version;
}

async function installNativePackage(
  spec: string,
  cwd: string,
  install: MontyNativeInstaller,
): Promise<{ command: string; detail: string }> {
  const npm = await install("npm", ["install", spec, "--no-save", "--no-package-lock"], { cwd });
  if (npm.exitCode === 0) return { command: `npm install ${spec}`, detail: npm.stdout };
  if (npm.exitCode !== COMMAND_NOT_FOUND_EXIT_CODE) {
    throw new Error(
      `Failed to install ${spec} with npm (exit ${npm.exitCode}): ${installDetail(npm)}`,
    );
  }

  const bun = await install("bun", ["add", spec, "--no-save"], { cwd });
  if (bun.exitCode === 0) return { command: `bun add ${spec}`, detail: bun.stdout };
  throw new Error(
    `Failed to install ${spec}: npm was not found, bun add exited ${bun.exitCode}: ${installDetail(bun)}`,
  );
}

async function defaultInstaller(
  command: string,
  args: readonly string[],
  options: { cwd: string },
): Promise<MontyNativeInstallResult> {
  const result = await exec.spawn(command, [...args], {
    cwd: options.cwd,
    stdout: "capture",
    stderr: "capture",
    stdin: "ignore",
    check: false,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function installDetail(result: MontyNativeInstallResult): string {
  return errorUtils.errorMessage(result.stderr || result.stdout || `exit ${result.exitCode}`);
}
