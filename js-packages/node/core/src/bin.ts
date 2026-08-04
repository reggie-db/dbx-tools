/**
 * Install and reuse executable binaries under a per-tool home directory.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
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
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { error, log } from "@dbx-tools/shared-core";
import extractZip from "extract-zip";
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
  selector?: BinSelector;
  homeDir?: string;
  /** Minimum accepted numeric version, with one to three components. */
  minVersion?: string;
  /** Argument passed to the binary for version detection. Defaults to `--version`. */
  versionArgument?: string;
  /** Version output parser. Defaults to {@link parseVersion}. */
  versionParser?: BinVersionParser;
}

/** A URL resolved only when the executable is not already installed. */
export type BinUrl = string | (() => string | Promise<string>);

function context(name: string, homeDir: string): BinContext {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new TypeError(`invalid binary name: ${name}`);
  }
  const root = join(homeDir, `.${name}`);
  const binDir = join(root, "bin");
  return { root, binDir, path: join(binDir, name) };
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

function numericVersion(version: string, strict: boolean): number[] | undefined {
  const pattern = strict ? /^\s*v?(\d+(?:\.\d+){0,2})\s*$/i : /\bv?(\d+(?:\.\d+){0,2})/i;
  const match = pattern.exec(version);
  return match?.[1]?.split(".").map(Number);
}

function meetsMinVersion(version: string, minVersion: string | undefined): boolean {
  if (!minVersion) return true;
  const actual = numericVersion(version, false);
  const minimum = numericVersion(minVersion, true);
  if (!minimum) {
    throw new TypeError(`invalid minimum binary version: ${minVersion}`);
  }
  if (!actual) return false;
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
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
      error: error.errorMessage(cause),
    });
    return false;
  }
  const version = (options.versionParser ?? parseVersion)({
    stdout,
    stderr,
  });
  const valid = version !== undefined && meetsMinVersion(version, options.minVersion);
  logger.debug("binary version checked", {
    path,
    version,
    minVersion: options.minVersion,
    valid,
  });
  return valid;
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

async function selectedBin(
  destination: BinContext,
  url: string,
  temp: string,
  options: BinOptions,
): Promise<string> {
  const name = downloadName(url, basename(destination.path));
  const downloadPath = join(temp, name);
  logger.debug("downloading binary", {
    from: displayUrl(url),
    to: downloadPath,
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`binary download failed (${response.status})`);
  }
  await writeFile(downloadPath, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });

  let source = downloadPath;
  if (options.autoUnpackage) {
    source = join(temp, `unpacked-${randomUUID()}`);
    await mkdir(source);
    logger.debug("unpacking binary archive", {
      archive: downloadPath,
      to: source,
    });
    await unpack(downloadPath, source);
  }

  if (options.selector) {
    const selected = await options.selector({ destination, downloadPath, source });
    logger.debug("selected binary", { path: selected });
    return selected;
  }
  const selected = options.autoUnpackage ? await selectSingleFile(source) : source;
  logger.debug("selected binary", { path: selected });
  return selected;
}

/**
 * Return an existing executable or install it atomically under
 * `$HOME/.<name>/bin/<name>`. Installation uses a check-lock-check-load
 * sequence so concurrent callers resolve and download the binary only once.
 * The downloaded candidate and final renamed executable must both pass the
 * same executable and version checks.
 */
export async function ensure(
  name: string,
  url: BinUrl,
  options: BinOptions = {},
): Promise<BinContext> {
  if (options.minVersion && !numericVersion(options.minVersion, true)) {
    throw new TypeError(`invalid minimum binary version: ${options.minVersion}`);
  }
  const destination = context(name, options.homeDir ?? homedir());
  if (await isValidBin(destination.path, options)) {
    logger.debug("using installed binary", { name, path: destination.path });
    return destination;
  }

  logger.debug("waiting for binary install lock", { name, path: destination.path });
  return withFileLock(["bin.ensure", destination.path], async () => {
    if (await isValidBin(destination.path, options)) {
      logger.debug("using binary installed by another caller", {
        name,
        path: destination.path,
      });
      return destination;
    }

    const resolvedUrl = typeof url === "function" ? await url() : url;
    const from = displayUrl(resolvedUrl);
    logger.debug("installing binary", {
      name,
      from,
      to: destination.path,
      minVersion: options.minVersion,
    });
    const temp = await mkdtemp(join(tmpdir(), `${name}-`));
    let staged: string | undefined;
    try {
      const selected = await selectedBin(destination, resolvedUrl, temp, options);
      await chmod(selected, 0o755);
      if (!(await isValidBin(selected, options))) {
        throw new Error(`selected binary has no acceptable version: ${selected}`);
      }

      await mkdir(destination.binDir, { recursive: true });
      staged = join(destination.binDir, `.${name}-${randomUUID()}`);
      await copyFile(selected, staged);
      await chmod(staged, 0o755);
      await rename(staged, destination.path);
      staged = undefined;
      if (!(await isValidBin(destination.path, options))) {
        throw new Error(`installed binary is invalid after rename: ${destination.path}`);
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
