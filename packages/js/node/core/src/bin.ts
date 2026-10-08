/**
 * Install and reuse executable binaries under a per-tool home directory.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as errorUtils from "@dbx-tools/shared-core/error-utils";
import * as log from "@dbx-tools/shared-core/log";
import extractZip from "extract-zip";
import { coerce, gte, type SemVer } from "semver";
import { x as extractTar } from "tar";

import { withFileLock } from "./file-lock.ts";

const execFileAsync = promisify(execFile);
const logger = log.logger("core:bin");

interface ParsedVersion {
  raw: string;
  parts: number[];
}

interface BinAccessContext {
  file: boolean;
  executable: boolean;
}

/** Stable paths for an installed binary. */
export interface BinContext {
  root: string;
  binDir: string;
  path: string;
}

/** Temporary download and extraction paths supplied to a custom selector. */
export interface BinSelectionContext {
  destination: BinContext;
  downloadPath: string;
  source: string;
}

/**
 * Select the executable from a download or unpacked archive. A selector may
 * also prepare the file, such as applying its executable mode.
 */
export type BinSelector = (context: BinSelectionContext) => string | Promise<string>;

/** Captured output passed to a custom binary version parser. */
export interface BinVersionOutput {
  stdout: string;
  stderr: string;
}

/** Extract a version string from a successful version-command result. */
export type BinVersionParser = (output: BinVersionOutput) => string | undefined;

/** Options for {@link ensure}. */
export interface BinOptions {
  autoUnpackage?: boolean;
  /** Preserve an unpacked multi-file package rooted at {@link BinContext.root}. */
  package?: BinPackageOptions;
  selector?: BinSelector;
  homeDir?: string;
  /** Exact installation paths. Omission keeps `$HOME/.<name>/bin/<name>`. */
  destination?: BinContext;
  /** Minimum accepted numeric version, with one to three components. */
  minVersion?: string;
  /** Argument passed to the binary for version detection. Defaults to `--version`. */
  versionArgument?: string;
  /** Version output parser. Defaults to {@link parseVersion}. */
  versionParser?: BinVersionParser;
  /** Skip `--version` and treat an executable file as acceptable. */
  skipVersionCheck?: boolean;
  /** Reinstall even when the destination already passes validation. */
  force?: boolean;
}

/** Multi-file archive layout retained beside its executable entrypoint. */
export interface BinPackageOptions {
  /** Executable path relative to the unpacked package root. */
  entrypoint: string;
  /** Companion files or directories required before an installation can be reused. */
  requiredPaths?: readonly string[];
}

/** Temporary directory created for one `ensure` attempt after the install lock. */
export interface BinUrlResolveContext {
  readonly tempDir: string;
}

/** Download source resolved only when the executable is not already installed. */
export interface BinSource {
  url: string;
  sha256?: string;
}

/** A download source resolved only when the executable is not already installed. */
export type BinUrl =
  | string
  | BinSource
  | ((context: BinUrlResolveContext) => string | BinSource | Promise<string | BinSource>);

function context(name: string, homeDir: string, destination?: BinContext): BinContext {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new TypeError(`invalid binary name: ${name}`);
  }
  if (destination) return destination;
  const root = join(homeDir, `.${name}`);
  const binDir = join(root, "bin");
  return { root, binDir, path: join(binDir, name) };
}

function packagePath(root: string, path: string): string {
  if (!path || isAbsolute(path)) {
    throw new TypeError(`invalid binary package path: ${path}`);
  }
  const packageRoot = resolve(root);
  const resolved = resolve(packageRoot, path);
  if (resolved === packageRoot || !resolved.startsWith(`${packageRoot}${sep}`)) {
    throw new TypeError(`binary package path escapes its root: ${path}`);
  }
  return resolved;
}

function packageDestination(destination: BinContext, options: BinOptions): void {
  if (!options.package) return;
  const entrypoint = packagePath(destination.root, options.package.entrypoint);
  if (resolve(destination.path) !== entrypoint) {
    throw new TypeError("binary package destination path must match its entrypoint");
  }
  for (const path of options.package.requiredPaths ?? []) {
    packagePath(destination.root, path);
  }
}

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:") return "data:";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

async function accessContext(path: string): Promise<BinAccessContext> {
  try {
    const entry = await stat(path);
    const file = entry.isFile();
    return {
      file,
      executable: file && (process.platform === "win32" || (entry.mode & 0o111) !== 0),
    };
  } catch {
    return { file: false, executable: false };
  }
}

function detectedVersions(output: string): ParsedVersion[] {
  const versions: ParsedVersion[] = [];
  const pattern = /\bv?(\d+(?:\.\d+){0,2})(?:[-+._]?[a-z][0-9a-z.+_-]*)?/gi;
  for (const match of output.matchAll(pattern)) {
    const raw = match[0].replace(/^v/i, "");
    const parts = match[1]?.split(".").map(Number);
    if (parts?.every(Number.isFinite)) versions.push({ raw, parts });
  }
  return versions.sort((a, b) => {
    if (a.parts.length !== b.parts.length) return b.parts.length - a.parts.length;
    for (let index = 0; index < a.parts.length; index += 1) {
      const order = (b.parts[index] ?? 0) - (a.parts[index] ?? 0);
      if (order !== 0) return order;
    }
    return 0;
  });
}

/**
 * Parse the deepest, highest version from stdout, falling back to stderr only
 * when stdout contains no version. Supports one to three numeric components
 * and common suffixes such as `rc1`, `.post1`, and `-dev.2`.
 */
export function parseVersion({ stdout, stderr }: BinVersionOutput): string | undefined {
  return detectedVersions(stdout).at(0)?.raw ?? detectedVersions(stderr).at(0)?.raw;
}

function minimumSemVer(version: string): SemVer | undefined {
  if (!/^\s*v?\d+(?:\.\d+){0,2}\s*$/i.test(version)) return undefined;
  return coerce(version, { loose: true }) ?? undefined;
}

/** Compare a detected tool version against a one-to-three-component minimum. */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const minimum = minimumSemVer(minVersion);
  if (!minimum) {
    throw new TypeError(`invalid minimum binary version: ${minVersion}`);
  }
  const actual = coerce(version, { loose: true });
  if (!actual) return false;
  return gte(actual, minimum);
}

async function isValidBin(path: string, options: BinOptions): Promise<boolean> {
  logger.debug("checking binary", {
    path,
    minVersion: options.minVersion,
    versionArgument: options.versionArgument ?? "--version",
  });
  const access = await accessContext(path);
  if (!access.file || !access.executable) {
    logger.debug("binary access check failed", { path, ...access });
    return false;
  }
  if (options.skipVersionCheck) {
    logger.debug("binary version check skipped", { path });
    return true;
  }
  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync(path, [options.versionArgument ?? "--version"], {
      encoding: "utf8",
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (cause) {
    logger.debug("binary version command failed", {
      path,
      error: errorUtils.errorMessage(cause),
    });
    return false;
  }
  const version = (options.versionParser ?? parseVersion)({
    stdout,
    stderr,
  });
  const valid =
    version !== undefined &&
    (options.minVersion === undefined || isVersionAtLeast(version, options.minVersion));
  logger.debug("binary version checked", {
    path,
    version,
    minVersion: options.minVersion,
    valid,
  });
  return valid;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isValidInstall(destination: BinContext, options: BinOptions): Promise<boolean> {
  if (!(await isValidBin(destination.path, options))) return false;
  if (!options.package) return true;
  const required = [options.package.entrypoint, ...(options.package.requiredPaths ?? [])];
  const available = await Promise.all(
    required.map((path) => pathExists(packagePath(destination.root, path))),
  );
  return available.every(Boolean);
}

function downloadName(url: string, name: string): string {
  try {
    const candidate = basename(decodeURIComponent(new URL(url).pathname));
    return candidate && Buffer.byteLength(candidate) <= 200 ? candidate : name;
  } catch {
    return name;
  }
}

async function unpack(archive: string, destination: string): Promise<void> {
  const filename = archive.toLowerCase();
  if (filename.endsWith(".zip")) {
    await extractZip(archive, { dir: destination });
    return;
  }
  if (filename.endsWith(".tar") || filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
    await extractTar({ file: archive, cwd: destination });
    return;
  }
  throw new Error(`unsupported binary archive: ${basename(archive)}`);
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function selectSingleFile(source: string): Promise<string> {
  const files = await filesUnder(source);
  const selected = files.at(0);
  if (files.length !== 1 || !selected) {
    throw new Error(`binary archive must contain one file, found ${files.length}`);
  }
  return selected;
}

function fileUrlPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

interface SelectedBin {
  path: string;
  packageRoot?: string;
}

async function selectedBin(
  destination: BinContext,
  source: BinSource,
  temp: string,
  options: BinOptions,
): Promise<SelectedBin> {
  const { url } = source;
  const localPath = fileUrlPath(url);
  let downloadPath: string;
  if (localPath) {
    const access = await accessContext(localPath);
    if (!access.file) {
      throw new Error(`binary file URL does not exist: ${displayUrl(url)}`);
    }
    logger.debug("using local binary", { from: displayUrl(url), path: localPath });
    downloadPath = localPath;
  } else {
    const name = downloadName(url, basename(destination.path));
    downloadPath = join(temp, name);
    const download = {
      from: displayUrl(url),
      to: downloadPath,
    };
    if (download.from === "data:") logger.debug("downloading binary", download);
    else logger.info("downloading binary", download);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`binary download failed (${response.status})`);
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (source.sha256) {
      if (!/^[0-9a-f]{64}$/i.test(source.sha256)) {
        throw new TypeError(
          "binary download SHA-256 digest must contain 64 hexadecimal characters",
        );
      }
      const actual = createHash("sha256").update(downloaded).digest("hex");
      if (actual.toLowerCase() !== source.sha256.toLowerCase()) {
        throw new Error(`binary download digest mismatch: ${displayUrl(url)}`);
      }
    }
    await writeFile(downloadPath, downloaded, { mode: 0o755 });
  }

  let selectedSource = downloadPath;
  let unpacked = false;
  if (options.package || (options.autoUnpackage && !localPath)) {
    selectedSource = join(temp, `unpacked-${randomUUID()}`);
    await mkdir(selectedSource);
    logger.info("unpacking binary archive", {
      archive: downloadPath,
      to: selectedSource,
    });
    await unpack(downloadPath, selectedSource);
    unpacked = true;
  }

  if (options.selector) {
    const selected = await options.selector({
      destination,
      downloadPath,
      source: selectedSource,
    });
    logger.debug("selected binary", { path: selected });
    return { path: selected, ...(options.package ? { packageRoot: selectedSource } : {}) };
  }
  if (options.package) {
    const selected = packagePath(selectedSource, options.package.entrypoint);
    logger.debug("selected binary package entrypoint", { path: selected });
    return { path: selected, packageRoot: selectedSource };
  }
  const selected = unpacked ? await selectSingleFile(selectedSource) : selectedSource;
  logger.debug("selected binary", { path: selected });
  return { path: selected };
}

async function installPackage(
  source: string,
  destination: BinContext,
  options: BinOptions,
): Promise<void> {
  if (!options.package) throw new Error("binary package options are required");
  const parent = dirname(destination.root);
  const name = basename(destination.root);
  const stagedRoot = join(parent, `.${name}-staged-${randomUUID()}`);
  const backupRoot = join(parent, `.${name}-backup-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  logger.info("staging binary package", {
    from: source,
    to: destination.root,
  });
  await cp(source, stagedRoot, { recursive: true });
  const stagedPath = packagePath(stagedRoot, options.package.entrypoint);
  await chmod(stagedPath, 0o755);
  const staged: BinContext = {
    root: stagedRoot,
    binDir: dirname(stagedPath),
    path: stagedPath,
  };
  if (!(await isValidInstall(staged, options))) {
    await rm(stagedRoot, { recursive: true, force: true });
    throw new Error(`selected binary package is invalid: ${source}`);
  }

  let backedUp = false;
  try {
    if (await pathExists(destination.root)) {
      await rename(destination.root, backupRoot);
      backedUp = true;
    }
    await rename(stagedRoot, destination.root);
    if (!(await isValidInstall(destination, options))) {
      throw new Error(`installed binary package is invalid after rename: ${destination.root}`);
    }
    if (backedUp) await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(destination.root, { recursive: true, force: true });
    if (backedUp) await rename(backupRoot, destination.root);
    throw error;
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
}

/**
 * Return an existing executable or install it atomically under
 * `$HOME/.<name>/bin/<name>`. Multi-file package mode atomically preserves the
 * unpacked package at an explicit destination root. Installation uses a
 * check-lock-check-load sequence so concurrent callers resolve and download
 * only once. Candidates and final destinations must pass the same checks.
 */
export async function ensure(
  name: string,
  url: BinUrl,
  options: BinOptions = {},
): Promise<BinContext> {
  if (options.minVersion && !minimumSemVer(options.minVersion)) {
    throw new TypeError(`invalid minimum binary version: ${options.minVersion}`);
  }
  const destination = context(name, options.homeDir ?? homedir(), options.destination);
  packageDestination(destination, options);
  if (!options.force && (await isValidInstall(destination, options))) {
    logger.debug("using installed binary", { name, path: destination.path });
    return destination;
  }

  logger.debug("waiting for binary install lock", { name, path: destination.path });
  return withFileLock(["bin.ensure", destination.path], async () => {
    if (!options.force && (await isValidInstall(destination, options))) {
      logger.debug("using binary installed by another caller", {
        name,
        path: destination.path,
      });
      return destination;
    }

    logger.debug("installing binary", {
      name,
      to: destination.path,
      minVersion: options.minVersion,
    });
    const temp = await mkdtemp(join(tmpdir(), `${name}-`));
    let staged: string | undefined;
    try {
      const resolved = typeof url === "function" ? await url({ tempDir: temp }) : url;
      const source = typeof resolved === "string" ? { url: resolved } : resolved;
      const from = displayUrl(source.url);
      logger.debug("resolved binary source", { name, from });
      const selected = await selectedBin(destination, source, temp, options);
      await chmod(selected.path, 0o755);
      if (!(await isValidBin(selected.path, options))) {
        throw new Error(`selected binary has no acceptable version: ${selected.path}`);
      }
      if (options.package) {
        if (!selected.packageRoot) throw new Error("binary package root was not selected");
        await installPackage(selected.packageRoot, destination, options);
      } else {
        await mkdir(destination.binDir, { recursive: true });
        staged = join(destination.binDir, `.${name}-${randomUUID()}`);
        await copyFile(selected.path, staged);
        await chmod(staged, 0o755);
        await rename(staged, destination.path);
        staged = undefined;
        if (!(await isValidInstall(destination, options))) {
          throw new Error(`installed binary is invalid after rename: ${destination.path}`);
        }
      }
      logger.info("installed binary", {
        name,
        from,
        to: destination.path,
      });
      return destination;
    } finally {
      if (staged) await rm(staged, { force: true });
      await rm(temp, { recursive: true, force: true });
    }
  });
}
