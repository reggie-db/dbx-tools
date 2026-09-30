#!/usr/bin/env -S bun
/** Idempotent npm archive publication for release recovery. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const logger = log.logger("dbx-tools:publish-npm");

export interface NpmReleaseIdentity {
  readonly contentDigest?: string;
  readonly integrity?: string;
  readonly name: string;
  readonly repository?: unknown;
  readonly version: string;
}

function normalizedRepository(value: unknown): string | undefined {
  const url =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "url" in value
        ? String(value.url)
        : undefined;
  return url
    ?.replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function registryUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function npmReleaseMatches(
  local: NpmReleaseIdentity,
  published: NpmReleaseIdentity | undefined,
): boolean {
  if (!published) return false;
  if (published.name !== local.name || published.version !== local.version) {
    throw new Error(`Published npm identity does not match ${local.name}@${local.version}`);
  }
  const localRepository = normalizedRepository(local.repository);
  const publishedRepository = normalizedRepository(published.repository);
  if (localRepository && publishedRepository && localRepository !== publishedRepository) {
    throw new Error(`Published npm repository does not match ${local.name}@${local.version}`);
  }
  if (
    local.contentDigest &&
    published.contentDigest &&
    local.contentDigest !== published.contentDigest
  ) {
    throw new Error(`Published npm content does not match ${local.name}@${local.version}`);
  }
  if (
    !(local.contentDigest && published.contentDigest) &&
    local.integrity &&
    published.integrity !== local.integrity
  ) {
    throw new Error(`Published npm integrity does not match ${local.name}@${local.version}`);
  }
  return true;
}

export async function publishedNpmRelease(
  name: string,
  version: string,
  registry = process.env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY,
): Promise<NpmReleaseIdentity | undefined> {
  const response = await fetch(registryUrl(registry, name, version), {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`npm registry lookup failed for ${name}@${version}: ${response.status}`);
  }
  const metadata = (await response.json()) as {
    dist?: { integrity?: string; tarball?: string };
    name?: string;
    repository?: unknown;
    version?: string;
  };
  if (!metadata.name || !metadata.version) {
    throw new Error(`npm registry returned an incomplete identity for ${name}@${version}`);
  }
  let contentDigest: string | undefined;
  if (metadata.dist?.tarball) {
    const archive = await fetch(metadata.dist.tarball);
    if (!archive.ok) {
      throw new Error(`npm tarball lookup failed for ${name}@${version}: ${archive.status}`);
    }
    const temp = mkdtempSync(join(tmpdir(), "dbx-tools-published-npm-"));
    const path = join(temp, "package.tgz");
    try {
      writeFileSync(path, Buffer.from(await archive.arrayBuffer()));
      contentDigest = npmArchiveContentDigest(path);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return {
    ...(contentDigest ? { contentDigest } : {}),
    integrity: metadata.dist?.integrity,
    name: metadata.name,
    repository: metadata.repository,
    version: metadata.version,
  };
}

export function readNpmArchiveIdentity(path: string): NpmReleaseIdentity {
  const result = exec.spawnSync("tar", ["-xOf", path, "package/package.json"], {
    cwd: process.cwd(),
    stdout: "capture",
    stderr: "capture",
    stdin: "ignore",
    check: false,
  });
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(`Cannot read npm package manifest from ${path}: ${result.stderr}`);
  }
  const manifest = JSON.parse(result.stdout) as {
    name?: string;
    repository?: unknown;
    version?: string;
  };
  if (!manifest.name || !manifest.version) {
    throw new Error(`npm archive has no package name or version: ${path}`);
  }
  return {
    contentDigest: npmArchiveContentDigest(path),
    integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`,
    name: manifest.name,
    repository: manifest.repository,
    version: manifest.version,
  };
}

/** Hash extracted paths, modes, symlink targets, and bytes while ignoring tar metadata. */
export function npmArchiveContentDigest(path: string): string {
  const temp = mkdtempSync(join(tmpdir(), "dbx-tools-npm-content-"));
  try {
    exec.spawnSync("tar", ["-xzf", path, "-C", temp], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "capture",
      stdin: "ignore",
      check: true,
    });
    const hash = createHash("sha512");
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const entryPath = join(directory, entry.name);
        const name = relative(temp, entryPath).split("\\").join("/");
        const stat = lstatSync(entryPath);
        hash.update(`${entry.isDirectory() ? "D" : entry.isSymbolicLink() ? "L" : "F"}\0`);
        hash.update(`${name}\0${stat.mode & 0o777}\0`);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isSymbolicLink()) hash.update(readlinkSync(entryPath));
        else hash.update(readFileSync(entryPath));
      }
    };
    visit(temp);
    return `sha512-${hash.digest("base64")}`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function packNpmPackage(
  directory: string,
  destination: string,
  path = process.env.PATH ?? "",
): string {
  const executable = process.versions.bun ? process.execPath : "bun";
  exec.spawnSync(
    executable,
    ["pm", "pack", "--destination", destination, "--ignore-scripts", "--quiet"],
    {
      cwd: directory,
      env: { ...process.env, PATH: path },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    },
  );
  const archives = readdirSync(destination).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one packed npm archive, found ${archives.length}`);
  }
  return join(destination, archives[0]);
}

export async function publishNpmArchives(options: {
  readonly directory: string;
  readonly dryRun?: boolean;
  readonly registry?: string;
  readonly version: string;
}): Promise<void> {
  const directory = resolve(options.directory);
  const archives = readdirSync(directory)
    .filter((file) => file.endsWith(".tgz"))
    .sort()
    .map((file) => join(directory, file));
  if (archives.length === 0) throw new Error(`No npm archives found in ${directory}`);

  for (const archive of archives) {
    const local = readNpmArchiveIdentity(archive);
    if (local.version !== options.version) {
      throw new Error(
        `npm archive ${archive} carries ${local.version}, expected ${options.version}`,
      );
    }
    if (!options.dryRun) {
      const published = await publishedNpmRelease(local.name, local.version, options.registry);
      if (npmReleaseMatches(local, published)) {
        logger.info(`skip published ${local.name}@${local.version}`);
        continue;
      }
    }
    exec.spawnSync(
      "npm",
      [
        "publish",
        archive,
        "--access",
        "public",
        ...(options.registry ? ["--registry", options.registry] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
      {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      },
    );
  }
}

if (import.meta.main) {
  const program = new Command();
  program
    .requiredOption("--directory <path>", "Directory containing npm archives")
    .requiredOption("--version <version>", "Exact npm release version")
    .option("--registry <url>", "npm registry URL")
    .option("--dry-run", "Validate archives without publishing")
    .action(
      (options: { directory: string; dryRun?: boolean; registry?: string; version: string }) =>
        publishNpmArchives(options),
    );
  await program.parseAsync();
}
