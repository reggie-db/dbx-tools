/**
 * Install and reuse executable binaries under a per-tool home directory.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
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

import extractZip from "extract-zip";
import { x as extractTar } from "tar";

import { withProcessLock } from "./process-lock.ts";

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

/** Options for {@link ensure}. */
export interface BinOptions {
  autoUnpackage?: boolean;
  selector?: BinSelector;
  homeDir?: string;
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

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`binary download failed (${response.status})`);
  }
  await writeFile(downloadPath, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });

  let source = downloadPath;
  if (options.autoUnpackage) {
    source = join(temp, `unpacked-${randomUUID()}`);
    await mkdir(source);
    await unpack(downloadPath, source);
  }

  if (options.selector) {
    return options.selector({ destination, downloadPath, source });
  }
  return options.autoUnpackage ? selectSingleFile(source) : source;
}

/**
 * Return an existing executable or install it atomically under
 * `$HOME/.<name>/bin/<name>`. Installation uses a check-lock-check-load
 * sequence so concurrent callers resolve and download the binary only once.
 */
export async function ensure(
  name: string,
  url: BinUrl,
  options: BinOptions = {},
): Promise<BinContext> {
  const destination = context(name, options.homeDir ?? homedir());
  if (await isExecutable(destination.path)) return destination;

  return withProcessLock(["bin.ensure", destination.path], async () => {
    if (await isExecutable(destination.path)) return destination;

    const resolvedUrl = typeof url === "function" ? await url() : url;
    const temp = await mkdtemp(join(tmpdir(), `${name}-`));
    let staged: string | undefined;
    try {
      const selected = await selectedBin(destination, resolvedUrl, temp, options);
      if (!(await isExecutable(selected))) {
        throw new Error(`selected binary is not executable: ${selected}`);
      }

      await mkdir(destination.binDir, { recursive: true });
      staged = join(destination.binDir, `.${name}-${randomUUID()}`);
      await copyFile(selected, staged);
      await chmod(staged, (await stat(selected)).mode);
      await rename(staged, destination.path);
      staged = undefined;
      return destination;
    } finally {
      if (staged) await rm(staged, { force: true });
      await rm(temp, { recursive: true, force: true });
    }
  });
}
