#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />

import { once } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, win32 as pathWin32 } from "node:path";
import { parseArgs } from "node:util";

/**
 * Standalone mise bootstrapper for Unix and Windows.
 *
 * Progress goes to stderr. Stdout contains only current-shell commands when
 * installation, PATH persistence, or profile activation changed.
 * `MISE_INSTALL_SHELL` selects the stdout dialect when it differs from
 * the login shell in `SHELL`.
 */
const MISE_REPOSITORY = "jdx/mise";

interface GitHubRelease {
  tag_name: string;
}

interface ParsedVersion {
  parts: number[];
  prerelease: boolean;
  raw: string;
}

/** Output destination for one log entry. */
export interface LogOptions {
  writer?: (message: string) => void;
}

/** Result of ensuring one runnable mise executable. */
export interface EnsureMiseResult {
  /** Whether installation or environment persistence changed. */
  changed: boolean;
  /** Runnable command or absolute executable path. */
  executable: string;
}

/** Options for resolving or installing one mise-backed executable. */
export interface EnsureCommandOptions {
  /** Mise tool specification. Defaults to the command name. */
  miseTool?: string;
  /** Arguments used to read the command version. Defaults to `--version`. */
  versionCommand?: string | readonly string[];
}

export interface CommandVersionOutput {
  stderr: string;
  stdout: string;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag_name" in value &&
    typeof value.tag_name === "string"
  );
}

type CommandOutputMode = "capture" | "ignore" | "stderr";
type MiseAssetArchitecture = "arm64" | "armv7" | "x64";
type MiseAssetPlatform = "linux" | "macos" | "windows";
type ShellActivationMode = "activate" | "path" | "shims";
type UnixShell = "bash" | "fish" | "zsh";

interface ShellProfile {
  mode: ShellActivationMode;
  path: string;
  shell?: UnixShell;
}

interface SpawnCommandOptions {
  check?: boolean;
  environment?: Readonly<NodeJS.ProcessEnv>;
  stderr?: CommandOutputMode;
  stdout?: CommandOutputMode;
  successfulExitCodes?: readonly number[];
}

interface SpawnCommandResult {
  exitCode: number;
  stderr?: string;
  stdout?: string;
}

/** Write one newline-terminated installer message. */
export function log(
  message: string,
  { writer = (output) => process.stderr.write(output) }: LogOptions = {},
): void {
  writer(`${message}\n`);
}

async function readCommandStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  mode: CommandOutputMode,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!stream || typeof stream === "number" || mode === "ignore") return undefined;
  const reader = stream.getReader();
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const decoder = mode === "capture" ? new TextDecoder() : undefined;
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (decoder) output += decoder.decode(value, { stream: true });
      else if (!process.stderr.write(value)) {
        await once(process.stderr, "drain", { signal });
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (!decoder) return undefined;
  return `${output}${decoder.decode()}`;
}

async function waitForChildExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    timeout.unref();
    void exited.then(
      () => {
        clearTimeout(timeout);
        resolveExit(true);
      },
      () => {
        clearTimeout(timeout);
        resolveExit(true);
      },
    );
  });
}

/**
 * Run one command with centralized output handling.
 *
 * Output streams default to stderr. Callers must opt into capture or ignore.
 */
async function spawnCommand(
  command: string[],
  options: SpawnCommandOptions = {},
): Promise<SpawnCommandResult> {
  const stdoutMode = options.stdout ?? "stderr";
  const stderrMode = options.stderr ?? "stderr";
  const child = Bun.spawn(command, {
    env: options.environment ?? process.env,
    stdin: "ignore",
    stdout: stdoutMode === "ignore" ? "ignore" : "pipe",
    stderr: stderrMode === "ignore" ? "ignore" : "pipe",
  });
  const outputController = new AbortController();
  const stdoutPromise = readCommandStream(child.stdout, stdoutMode, outputController.signal);
  const stderrPromise = readCommandStream(child.stderr, stderrMode, outputController.signal);
  let stdout: string | undefined;
  let stderr: string | undefined;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, child.exited]);
  } catch (error) {
    outputController.abort(error);
    try {
      child.kill("SIGTERM");
    } catch (killError) {
      log(`Could not terminate ${command[0]}: ${getErrorMessage(killError)}`);
    }
    const exited = await waitForChildExit(child.exited, 2_000);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch (killError) {
        log(`Could not kill ${command[0]}: ${getErrorMessage(killError)}`);
      }
      await waitForChildExit(child.exited, 1_000);
    }
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw error;
  }
  const successfulExitCodes = options.successfulExitCodes ?? [0];
  if ((options.check ?? true) && !successfulExitCodes.includes(exitCode)) {
    throw new Error(`${command[0]} exited with code ${exitCode}`);
  }
  return {
    exitCode,
    ...(stderr !== undefined ? { stderr } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
  };
}

function getWindowsUserProfile(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return environment.USERPROFILE || homedir();
}

function getWindowsLocalAppData(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return (
    environment.LOCALAPPDATA ||
    pathWin32.join(getWindowsUserProfile(environment), "AppData", "Local")
  );
}

/**
 * Resolve the direct-download binary path.
 *
 * `MISE_INSTALL_PATH` always wins. Unix follows `mise.run`; Windows uses the
 * selected per-user location because mise has no official Windows installer
 * script or manual-install destination.
 */
export function getMiseInstallPath(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (environment.MISE_INSTALL_PATH) return environment.MISE_INSTALL_PATH;
  if (platform === "win32") {
    return pathWin32.join(getWindowsLocalAppData(environment), "mise", "bin", "mise.exe");
  }
  const homeDirectory = environment.HOME || homedir();
  return join(homeDirectory, ".local", "bin", "mise");
}

/** Return whether a command can run successfully with the supplied arguments. */
async function canRunCommand(
  command: string[],
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<boolean> {
  try {
    const result = await spawnCommand(command, {
      check: false,
      environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Return whether a mise executable can successfully show `mise use --help`. */
export function isMiseAvailable(command = "mise"): Promise<boolean> {
  return canRunCommand([command, "use", "--help"]);
}

/** Add one directory to the front of this process's PATH once. */
function addDirectoryToPath(directory: string): boolean {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (pathEntries.includes(directory)) return false;
  process.env.PATH = [directory, ...pathEntries].join(delimiter);
  return true;
}

/** Add mise's official installer directory to this process's PATH once. */
export function addMiseToPath(installPath = getMiseInstallPath()): boolean {
  return addDirectoryToPath(dirname(installPath));
}

function getAssetPlatform(platform: NodeJS.Platform): MiseAssetPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  throw new Error(`mise has no installer binary for ${platform}`);
}

function getAssetArchitecture(
  architecture: NodeJS.Architecture,
  platform: NodeJS.Platform,
): MiseAssetArchitecture {
  if (architecture === "x64") return "x64";
  if (architecture === "arm64") return "arm64";
  if (architecture === "arm" && platform !== "win32") return "armv7";
  throw new Error(`mise has no installer binary for ${architecture}`);
}

/** Build the official GitHub release asset name for one supported target. */
export function getMiseReleaseAsset(
  version: string,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
  musl = false,
): string {
  const windows = platform === "win32";
  const muslSuffix = !windows && musl ? "-musl" : "";
  const extension = windows ? "exe" : "tar.gz";
  return `mise-v${version}-${getAssetPlatform(platform)}-${getAssetArchitecture(architecture, platform)}${muslSuffix}.${extension}`;
}

async function isMuslLinux(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (["1", "true"].includes(process.env.MISE_INSTALL_MUSL ?? "")) return true;
  try {
    const result = await spawnCommand(["ldd", "/bin/ls"], {
      check: false,
      stdout: "capture",
      stderr: "capture",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return output.toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

/** Return whether a filesystem path exists as a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function fetchRequiredResponse(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "dbx-tools-mise-installer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return response;
}

async function fetchLatestVersion(): Promise<string> {
  const response = await fetchRequiredResponse(
    `https://api.github.com/repos/${MISE_REPOSITORY}/releases/latest`,
  );
  const release: unknown = await response.json();
  if (!isGitHubRelease(release)) throw new Error("unexpected GitHub release response");
  const version = release.tag_name.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unexpected mise release tag: ${release.tag_name}`);
  }
  return version;
}

async function fetchExpectedChecksum(version: string, asset: string): Promise<string> {
  const checksumsUrl = `https://github.com/${MISE_REPOSITORY}/releases/download/v${version}/SHASUMS256.txt`;
  const checksums = await (await fetchRequiredResponse(checksumsUrl)).text();
  const line = checksums.split("\n").find((candidate) => candidate.trim().endsWith(`./${asset}`));
  const checksum = line?.trim().split(/\s+/)[0];
  if (!checksum || !/^[a-f\d]{64}$/i.test(checksum)) {
    throw new Error(`no checksum published for ${asset}`);
  }
  return checksum.toLowerCase();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDetectedVersions(output: string): ParsedVersion[] {
  const versions: ParsedVersion[] = [];
  const pattern = /\bv?(\d+(?:\.\d+){0,2})(?:(?:[-+._][0-9a-z]|[a-z])[0-9a-z.+_-]*)?/gi;
  for (const match of output.matchAll(pattern)) {
    const raw = match[0].replace(/^v/i, "");
    const parts = match[1]?.split(".").map(Number);
    if (parts?.every(Number.isFinite)) {
      const numeric = match[1] ?? "";
      const suffix = raw.slice(numeric.length);
      versions.push({
        parts,
        prerelease:
          suffix.length > 0 && !suffix.startsWith("+") && !suffix.toLowerCase().startsWith(".post"),
        raw,
      });
    }
  }
  return versions;
}

/** Parse the first numeric version from stdout, falling back to stderr. */
export function parseCommandVersion({ stdout, stderr }: CommandVersionOutput): string | undefined {
  return getDetectedVersions(stdout).at(0)?.raw ?? getDetectedVersions(stderr).at(0)?.raw;
}

function getNumericVersion(version: string, strict: boolean): number[] | undefined {
  const pattern = strict ? /^\s*v?(\d+(?:\.\d+){0,2})\s*$/i : /\bv?(\d+(?:\.\d+){0,2})/i;
  return pattern.exec(version)?.[1]?.split(".").map(Number);
}

function meetsMinVersion(version: string, minVersion: string): boolean {
  const actual = getDetectedVersions(version).at(0);
  const minimum = getNumericVersion(minVersion, true);
  if (!minimum) throw new TypeError(`invalid minimum version: ${minVersion}`);
  if (!actual) return false;
  for (let index = 0; index < Math.max(actual.parts.length, minimum.length); index += 1) {
    const difference = (actual.parts[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return !actual.prerelease;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function buildPowerShellCommand(command: string): string[] {
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
}

async function readCommandOutput(
  command: string[],
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<string> {
  const result = await spawnCommand(command, {
    environment,
    stdout: "capture",
  });
  return (result.stdout ?? "").trim();
}

async function canRunPowerShellCommand(command: string): Promise<boolean> {
  return canRunCommand(buildPowerShellCommand(command));
}

function isWingetAvailable(): Promise<boolean> {
  return canRunCommand(["winget", "--version"]);
}

function isHomebrewAvailable(): Promise<boolean> {
  return canRunCommand(["brew", "--version"]);
}

async function findHomebrewMise(): Promise<string | undefined> {
  try {
    const prefix = await readCommandOutput(["brew", "--prefix", "mise"]);
    const executable = join(prefix, "bin", "mise");
    return (await isMiseAvailable(executable)) ? executable : undefined;
  } catch {
    return undefined;
  }
}

async function installMiseWithHomebrew(): Promise<string | undefined> {
  if (!(await isHomebrewAvailable())) return undefined;
  const existing = await findHomebrewMise();
  if (existing) return existing;
  try {
    log("Installing mise with Homebrew...");
    await spawnCommand(["brew", "install", "mise"]);
    const installed = await findHomebrewMise();
    if (installed) return installed;
    log("Homebrew completed but mise is not runnable; using the direct installer.");
  } catch (error) {
    log(`Homebrew could not install mise: ${getErrorMessage(error)}`);
  }
  return undefined;
}

async function refreshWindowsPath(): Promise<void> {
  const script = [
    "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
    'Write-Output "$machine;$user"',
  ].join("\n");
  const path = await readCommandOutput(buildPowerShellCommand(script));
  for (const entry of path.split(";").filter(Boolean).reverse()) {
    addDirectoryToPath(entry);
  }
}

async function installMiseWithScoop(): Promise<string | undefined> {
  if (!(await canRunPowerShellCommand("Get-Command scoop -ErrorAction Stop | Out-Null"))) {
    return undefined;
  }
  const scoopDirectory = process.env.SCOOP || join(getWindowsUserProfile(), "scoop");
  const shim = join(scoopDirectory, "shims", "mise.exe");
  addDirectoryToPath(dirname(shim));
  if (await isMiseAvailable(shim)) return shim;
  try {
    log("Installing mise with Scoop...");
    await spawnCommand(buildPowerShellCommand("scoop install mise"));
    if (await isMiseAvailable(shim)) return shim;
    if (await isMiseAvailable()) return "mise";
    log("Scoop completed but mise is not runnable; trying the next installer.");
  } catch (error) {
    log(`Scoop could not install mise: ${getErrorMessage(error)}`);
  }
  return undefined;
}

async function installMiseWithWinget(): Promise<string | undefined> {
  if (!(await isWingetAvailable())) return undefined;
  const link = join(getWindowsLocalAppData(), "Microsoft", "WinGet", "Links", "mise.exe");
  addDirectoryToPath(dirname(link));
  if (await isMiseAvailable(link)) return link;
  try {
    log("Installing mise with winget...");
    await spawnCommand([
      "winget",
      "install",
      "--id",
      "jdx.mise",
      "--exact",
      "--silent",
      "--disable-interactivity",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    await refreshWindowsPath();
    if (await isMiseAvailable(link)) return link;
    if (await isMiseAvailable()) return "mise";
    log("winget completed but mise is not runnable; using the direct installer.");
  } catch (error) {
    log(`winget could not install mise: ${getErrorMessage(error)}`);
  }
  return undefined;
}

async function installMiseWithWindowsPackageManager(): Promise<string | undefined> {
  return (await installMiseWithScoop()) ?? (await installMiseWithWinget());
}

async function persistWindowsUserPath(directory: string): Promise<boolean> {
  const script = [
    "$target = $env:INSTALL_DIRECTORY",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$entries = @($current -split ';' | Where-Object { $_ })",
    "if ($entries -notcontains $target) {",
    '  $updated = if ([string]::IsNullOrEmpty($current)) { $target } else { "$target;$current" }',
    "  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
    "  Write-Output 'changed'",
    "} else {",
    "  Write-Output 'unchanged'",
    "}",
  ].join("\n");
  const result = await spawnCommand(buildPowerShellCommand(script), {
    environment: { ...process.env, INSTALL_DIRECTORY: directory },
    stdout: "capture",
  });
  return result.stdout?.trim() === "changed";
}

function getWindowsRuntimeArchitecture(): "arm64" | "x64" {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`mise has no Windows runtime for ${process.arch}`);
}

async function isWindowsRuntimeAvailable(
  architecture = getWindowsRuntimeArchitecture(),
): Promise<boolean> {
  const script = [
    "$runtime = Get-ItemProperty",
    '  -Path "HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\$env:RUNTIME_ARCHITECTURE"',
    "  -ErrorAction SilentlyContinue",
    "if ($null -ne $runtime -and $runtime.Installed -eq 1) { exit 0 }",
    "exit 1",
  ].join(" ");
  return canRunCommand(buildPowerShellCommand(script), {
    ...process.env,
    RUNTIME_ARCHITECTURE: architecture,
  });
}

async function installWindowsRuntime(): Promise<void> {
  const architecture = getWindowsRuntimeArchitecture();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mise-runtime-install-"));
  const installerPath = join(temporaryDirectory, `vc_redist.${architecture}.exe`);
  try {
    const response = await fetchRequiredResponse(
      `https://aka.ms/vs/17/release/vc_redist.${architecture}.exe`,
    );
    await Bun.write(installerPath, await response.arrayBuffer());
    const verifySignature = [
      "$signature = Get-AuthenticodeSignature -FilePath $env:INSTALLER_PATH",
      "if ($signature.Status -ne 'Valid') { exit 1 }",
      "if ($signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { exit 1 }",
    ].join("\n");
    await spawnCommand(buildPowerShellCommand(verifySignature), {
      environment: { ...process.env, INSTALLER_PATH: installerPath },
    });
    log(`Installing the Microsoft VC++ ${architecture} runtime...`);
    await spawnCommand([installerPath, "/install", "/quiet", "/norestart"], {
      successfulExitCodes: [0, 1638, 3010],
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (!(await isWindowsRuntimeAvailable(architecture))) {
    throw new Error(`Microsoft VC++ ${architecture} runtime was installed but is unavailable`);
  }
}

async function replaceWindowsFile(stagedPath: string, destinationPath: string): Promise<void> {
  const script = [
    "if (Test-Path -LiteralPath $env:DESTINATION_PATH) {",
    "  [System.IO.File]::Replace($env:STAGED_PATH, $env:DESTINATION_PATH, $null)",
    "} else {",
    "  [System.IO.File]::Move($env:STAGED_PATH, $env:DESTINATION_PATH)",
    "}",
  ].join("\n");
  await spawnCommand(buildPowerShellCommand(script), {
    environment: {
      ...process.env,
      DESTINATION_PATH: destinationPath,
      STAGED_PATH: stagedPath,
    },
  });
}

const PROFILE_BLOCK_START = "# >>> mise installer >>>";
const PROFILE_BLOCK_END = "# <<< mise installer <<<";

function getUnixShell(shellPath = process.env.SHELL ?? ""): UnixShell | undefined {
  const shell = basename(shellPath);
  if (shell === "bash" || shell === "fish" || shell === "zsh") return shell;
  return undefined;
}

function getEvaluationShell(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): UnixShell | undefined {
  return getUnixShell(environment.MISE_INSTALL_SHELL || environment.SHELL);
}

function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function hasProfilePath(content: string, directory: string): boolean {
  const expected = `export PATH=${toShellLiteral(directory)}:"$PATH"`;
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === expected || trimmed.startsWith(`${expected} #`);
  });
}

function hasShellActivation(
  content: string,
  shell: UnixShell,
  mode: Exclude<ShellActivationMode, "path">,
): boolean {
  const suffix = mode === "shims" ? "\\s+--shims" : "";
  const pattern =
    shell === "fish"
      ? /^\s*(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\]+)+\s+activate\s+fish\s*\|\s*source\s*(?:#.*)?$/
      : new RegExp(
          `^\\s*eval\\s+["']?\\$\\(.+\\sactivate\\s+${shell}${suffix}\\)["']?\\s*(?:#.*)?$`,
        );
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#") && pattern.test(line);
  });
}

interface ManagedProfileRange {
  end: number;
  start: number;
}

function toRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findProfileMarker(
  content: string,
  marker: string,
): { end: number; start: number } | undefined {
  const matches = [...content.matchAll(new RegExp(`^${toRegExpLiteral(marker)}\\r?$`, "gm"))];
  if (matches.length > 1) {
    throw new Error(`shell profile contains multiple '${marker}' markers`);
  }
  const match = matches[0];
  return match?.index === undefined
    ? undefined
    : { start: match.index, end: match.index + match[0].length };
}

function getManagedProfileRange(content: string): ManagedProfileRange | undefined {
  const start = findProfileMarker(content, PROFILE_BLOCK_START);
  const end = findProfileMarker(content, PROFILE_BLOCK_END);
  if (Boolean(start) !== Boolean(end) || (start && end && end.start < start.start)) {
    throw new Error("shell profile contains an incomplete mise installer block");
  }
  return start && end ? { start: start.start, end: end.end } : undefined;
}

function getUnmanagedProfileText(content: string): string {
  const range = getManagedProfileRange(content);
  return range ? `${content.slice(0, range.start)}${content.slice(range.end)}` : content;
}

function buildProfileLines(profile: ShellProfile, executable: string, content: string): string[] {
  const unmanagedContent = getUnmanagedProfileText(content);
  const executablePath = executable === "mise" ? executable : resolve(executable);
  const executableCommand =
    executablePath === "mise" ? executablePath : toShellLiteral(executablePath);
  const installDirectory = executablePath === "mise" ? undefined : dirname(executablePath);
  const lines: string[] = [];

  if (
    profile.mode !== "activate" &&
    installDirectory &&
    !hasProfilePath(unmanagedContent, installDirectory)
  ) {
    lines.push(`export PATH=${toShellLiteral(installDirectory)}:"$PATH"`);
  }

  if (
    profile.shell &&
    profile.mode !== "path" &&
    !hasShellActivation(unmanagedContent, profile.shell, profile.mode)
  ) {
    lines.push(
      profile.shell === "fish"
        ? `${executableCommand} activate fish | source`
        : `eval "$(${executableCommand} activate ${profile.shell}${profile.mode === "shims" ? " --shims" : ""})"`,
    );
  }

  return lines;
}

/** Replace or append the installer-owned profile block without changing other content. */
export function updateManagedProfileText(content: string, lines: readonly string[]): string {
  const range = getManagedProfileRange(content);
  const block = `${PROFILE_BLOCK_START}\n${lines.join("\n")}\n${PROFILE_BLOCK_END}`;
  if (range) {
    return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  }
  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
}

async function readProfileText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

async function getProfileWritePath(path: string): Promise<string> {
  try {
    return (await lstat(path)).isSymbolicLink() ? await realpath(path) : path;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return path;
    throw error;
  }
}

async function writeProfileText(path: string, content: string): Promise<void> {
  const target = await getProfileWritePath(path);
  const directory = dirname(target);
  const stagedPath = join(directory, `.${basename(target)}.${crypto.randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(stagedPath, content, "utf8");
    if (mode !== undefined) await chmod(stagedPath, mode);
    await rename(stagedPath, target);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function getVersionArguments(
  versionCommand: EnsureCommandOptions["versionCommand"],
): readonly string[] {
  if (versionCommand === undefined) return ["--version"];
  return typeof versionCommand === "string" ? [versionCommand] : versionCommand;
}

function getExecutableCandidates(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string[] {
  if (command.includes("/") || command.includes("\\")) {
    return [resolve(command)];
  }
  const pathEntries = (environment.PATH ?? "").split(delimiter);
  const names =
    process.platform === "win32" && !pathWin32.extname(command)
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((extension) => `${command}${extension.toLowerCase()}`)
      : [command];
  return [
    ...new Set(
      pathEntries.flatMap((entry) => names.map((name) => resolve(entry || process.cwd(), name))),
    ),
  ];
}

async function isCommandVersionValid(
  executable: string,
  minVersion: string,
  versionArguments: readonly string[],
): Promise<boolean> {
  if (!(await isFile(executable))) return false;
  try {
    const result = await spawnCommand([executable, ...versionArguments], {
      check: false,
      stdout: "capture",
      stderr: "capture",
    });
    if (result.exitCode !== 0) return false;
    const version = parseCommandVersion({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    return version !== undefined && meetsMinVersion(version, minVersion);
  } catch {
    return false;
  }
}

async function findCommandExecutable(
  command: string,
  minVersion: string,
  versionArguments: readonly string[],
): Promise<string | undefined> {
  for (const candidate of getExecutableCandidates(command)) {
    if (await isCommandVersionValid(candidate, minVersion, versionArguments)) {
      return candidate;
    }
  }
  return undefined;
}

async function findBashLoginProfile(homeDirectory: string): Promise<string> {
  const profiles = [".bash_profile", ".bash_login", ".profile"].map((name) =>
    join(homeDirectory, name),
  );
  for (const profile of profiles) {
    if (await isFile(profile)) return profile;
  }
  return join(homeDirectory, ".profile");
}

async function getShellProfiles(
  shell: UnixShell | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ShellProfile[]> {
  const homeDirectory = environment.HOME || homedir();
  if (shell === "zsh") {
    const directory = environment.ZDOTDIR || homeDirectory;
    return [
      { mode: "shims", path: join(directory, ".zprofile"), shell },
      { mode: "activate", path: join(directory, ".zshrc"), shell },
    ];
  }
  if (shell === "bash") {
    return [
      {
        mode: "shims",
        path: await findBashLoginProfile(homeDirectory),
        shell,
      },
      { mode: "activate", path: join(homeDirectory, ".bashrc"), shell },
    ];
  }
  if (shell === "fish") {
    const configDirectory = environment.XDG_CONFIG_HOME || join(homeDirectory, ".config");
    return [
      {
        mode: "activate",
        path: join(configDirectory, "fish", "config.fish"),
        shell,
      },
    ];
  }
  return [{ mode: "path", path: join(homeDirectory, ".profile") }];
}

function shouldModifyShellProfiles(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return !["1", "true"].includes(environment.MISE_INSTALL_NO_MODIFY_PATH?.toLowerCase() ?? "");
}

async function findMiseExecutable(executable: string): Promise<string> {
  if (executable !== "mise") return resolve(executable);
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(pathEntry || process.cwd(), "mise");
    if (await isMiseAvailable(candidate)) return candidate;
  }
  return executable;
}

async function configureUnixShellProfiles(executable: string): Promise<boolean> {
  if (!shouldModifyShellProfiles()) return false;
  let profiles: ShellProfile[];
  try {
    profiles = await getShellProfiles(getUnixShell());
  } catch (error) {
    log(`Could not discover shell profiles: ${getErrorMessage(error)}`);
    return false;
  }
  let changed = false;
  for (const profile of profiles) {
    try {
      const content = await readProfileText(profile.path);
      const lines = buildProfileLines(profile, executable, content);
      if (lines.length === 0 && !getManagedProfileRange(content)) continue;
      const updated = updateManagedProfileText(content, lines);
      if (updated === content) continue;
      await writeProfileText(profile.path, updated);
      changed = true;
      log(`Configured mise shell setup in ${profile.path}`);
    } catch (error) {
      log(`Could not update ${profile.path}: ${getErrorMessage(error)}`);
    }
  }
  return changed;
}

function buildUnixSessionCommands(executable: string, shell: UnixShell | undefined): string[] {
  const executablePath = executable === "mise" ? executable : resolve(executable);
  const executableCommand =
    executablePath === "mise" ? executablePath : toShellLiteral(executablePath);
  const commands: string[] = [];
  if (executablePath !== "mise") {
    const installDirectory = dirname(executablePath);
    commands.push(
      shell === "fish"
        ? `fish_add_path --path --prepend --move ${toShellLiteral(installDirectory)}`
        : `case ":$PATH:" in *:${toShellLiteral(installDirectory)}:*) ;; *) export PATH=${toShellLiteral(installDirectory)}:"$PATH" ;; esac`,
    );
  }
  if (shell === "bash" || shell === "zsh") {
    commands.push(`eval "$(${executableCommand} activate ${shell})"`);
  } else if (shell === "fish") {
    commands.push(`${executableCommand} activate fish | source`);
  }
  return commands;
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildWindowsSessionCommands(executable: string): string[] {
  return [
    "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
    `(& ${toPowerShellLiteral(executable)} activate pwsh) | Out-String | Invoke-Expression`,
  ];
}

function writeSetupCommands(commands: readonly string[]): void {
  for (const command of commands) {
    log(command, { writer: (message) => process.stdout.write(message) });
  }
}

/**
 * Ensure mise is runnable through an existing, package-managed, or direct install.
 *
 * Windows resolves a relative direct-install path against this process's
 * working directory before persisting it in the user PATH.
 */
export async function ensureMiseAvailable(): Promise<EnsureMiseResult> {
  const windows = process.platform === "win32";
  const configuredInstallPath = getMiseInstallPath();
  const installPath = windows ? resolve(configuredInstallPath) : configuredInstallPath;
  const explicitInstallPath = Boolean(process.env.MISE_INSTALL_PATH);
  const availableOnPath = await isMiseAvailable();
  if (!explicitInstallPath && availableOnPath) {
    return { changed: false, executable: "mise" };
  }

  if (await isMiseAvailable(installPath)) {
    const processPathChanged = addMiseToPath(installPath);
    const persistentPathChanged = windows
      ? await persistWindowsUserPath(dirname(installPath))
      : false;
    return {
      changed: processPathChanged || persistentPathChanged,
      executable: installPath,
    };
  }
  if (process.platform === "darwin" && !explicitInstallPath) {
    const homebrewExecutable = await installMiseWithHomebrew();
    if (homebrewExecutable) {
      return { changed: true, executable: homebrewExecutable };
    }
  }
  // Scoop and winget own their destinations, so an explicit path requires the
  // direct installer to preserve the caller's location contract.
  if (windows && !explicitInstallPath) {
    const packageManagerExecutable = await installMiseWithWindowsPackageManager();
    if (packageManagerExecutable) {
      return { changed: true, executable: packageManagerExecutable };
    }
  }
  if (await isDirectory(installPath)) {
    const binaryName = windows ? "mise.exe" : "mise";
    throw new Error(
      `MISE_INSTALL_PATH '${installPath}' is a directory; set it to a binary file path such as '${join(installPath, binaryName)}'`,
    );
  }

  log(`Installing mise directly to ${installPath}...`);
  const version = await fetchLatestVersion();
  const asset = getMiseReleaseAsset(version, process.platform, process.arch, await isMuslLinux());
  const releaseUrl = `https://github.com/${MISE_REPOSITORY}/releases/download/v${version}/${asset}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mise-install-"));
  const installDirectory = dirname(installPath);
  const stagedPath = join(installDirectory, `.${basename(installPath)}.${crypto.randomUUID()}.tmp`);

  try {
    const archivePath = join(temporaryDirectory, asset);
    const download = new Uint8Array(await (await fetchRequiredResponse(releaseUrl)).arrayBuffer());
    const actualChecksum = new Bun.CryptoHasher("sha256").update(download).digest("hex");
    const checksum = await fetchExpectedChecksum(version, asset);
    if (actualChecksum !== checksum) throw new Error(`checksum mismatch for ${asset}`);
    await mkdir(installDirectory, { recursive: true });

    if (windows) {
      await Bun.write(stagedPath, download);
      if (!(await isMiseAvailable(stagedPath))) {
        await installWindowsRuntime();
        if (!(await isMiseAvailable(stagedPath))) {
          throw new Error("mise is not runnable after installing the Microsoft VC++ runtime");
        }
      }
      await replaceWindowsFile(stagedPath, installPath);
    } else {
      await Bun.write(archivePath, download);
      const extractDirectory = join(temporaryDirectory, "extract");
      await mkdir(extractDirectory);
      await spawnCommand(["tar", "--no-same-owner", "-xzf", archivePath, "-C", extractDirectory]);
      await copyFile(join(extractDirectory, "mise", "bin", "mise"), stagedPath);
      await chmod(stagedPath, 0o755);
      await rename(stagedPath, installPath);
    }
  } finally {
    await rm(stagedPath, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  if (!(await isMiseAvailable(installPath))) {
    throw new Error(`mise was installed to ${installPath} but is not runnable`);
  }
  addMiseToPath(installPath);
  if (windows) await persistWindowsUserPath(installDirectory);
  return { changed: true, executable: installPath };
}

/**
 * Return a command satisfying the minimum version, installing it with mise
 * only when no acceptable executable is already on PATH.
 */
export async function ensureCommand(
  command: string,
  minVersion: string,
  options: EnsureCommandOptions = {},
): Promise<string> {
  if (
    !command ||
    command.trim() !== command ||
    command.startsWith("-") ||
    basename(command) !== command ||
    pathWin32.basename(command) !== command
  ) {
    throw new TypeError("command must be a bare executable name");
  }
  if (!getNumericVersion(minVersion, true)) {
    throw new TypeError(`invalid minimum version: ${minVersion}`);
  }
  const miseTool = options.miseTool ?? command;
  if (
    !miseTool ||
    miseTool.trim() !== miseTool ||
    miseTool.startsWith("-") ||
    /\s/.test(miseTool)
  ) {
    throw new TypeError("miseTool must be a non-option tool specification");
  }
  const versionArguments = getVersionArguments(options.versionCommand);
  const existing = await findCommandExecutable(command, minVersion, versionArguments);
  if (existing) return existing;

  const mise = await ensureMiseAvailable();
  const miseExecutable = await findMiseExecutable(mise.executable);
  await spawnCommand([miseExecutable, "use", "-g", "--yes", "--", miseTool]);
  const resolved = await spawnCommand([miseExecutable, "which", command, "--tool", miseTool], {
    stdout: "capture",
  });
  const executable = resolved.stdout?.trim().split("\n")[0];
  if (!executable || !(await isCommandVersionValid(executable, minVersion, versionArguments))) {
    throw new Error(`mise tool '${miseTool}' did not provide ${command} ${minVersion} or newer`);
  }
  return executable;
}

function getUsage(): string {
  return [
    "Usage:",
    "  bun scripts/install.ts",
    "  bun scripts/install.ts <command> [--minVersion <version>] [--versionCommand <argument>] [--miseTool <spec>]",
    "",
    "Examples:",
    "  bun scripts/install.ts node",
    "  bun scripts/install.ts caddy --minVersion 2.10.2 --versionCommand version",
    "  bun scripts/install.ts caddy --miseTool github:caddyserver/caddy",
  ].join("\n");
}

async function runMiseSetup(): Promise<void> {
  const result = await ensureMiseAvailable();
  if (process.platform === "win32") {
    if (result.changed) {
      writeSetupCommands(buildWindowsSessionCommands(result.executable));
    }
    return;
  }
  const executable = await findMiseExecutable(result.executable);
  const profilesChanged = await configureUnixShellProfiles(executable);
  if (result.changed || profilesChanged) {
    writeSetupCommands(buildUnixSessionCommands(executable, getEvaluationShell()));
  }
}

async function runCli(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      minVersion: { type: "string", default: "0" },
      miseTool: { type: "string" },
      versionCommand: { type: "string", default: "--version" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${getUsage()}\n`);
    return;
  }
  const [command, ...rest] = positionals;
  if (!command || rest.length > 0) {
    throw new TypeError(`invalid command\n${getUsage()}`);
  }
  const executable = await ensureCommand(command, values.minVersion, {
    ...(values.miseTool ? { miseTool: values.miseTool } : {}),
    versionCommand: values.versionCommand,
  });
  process.stdout.write(`${executable}\n`);
}

if (import.meta.main) {
  try {
    if (Bun.argv.length <= 2) await runMiseSetup();
    else await runCli(Bun.argv.slice(2));
  } catch (error) {
    log(getErrorMessage(error));
    process.exitCode = 2;
  }
}
