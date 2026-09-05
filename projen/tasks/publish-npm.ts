#!/usr/bin/env -S bun
/** Idempotent npm archive publication for release recovery. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const logger = log.logger("dbx-tools:publish-npm");

export interface NpmReleaseIdentity {
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
  if (local.integrity && published.integrity !== local.integrity) {
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
    dist?: { integrity?: string };
    name?: string;
    repository?: unknown;
    version?: string;
  };
  if (!metadata.name || !metadata.version) {
    throw new Error(`npm registry returned an incomplete identity for ${name}@${version}`);
  }
  return {
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
    integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`,
    name: manifest.name,
    repository: manifest.repository,
    version: manifest.version,
  };
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
