#!/usr/bin/env -S bun
/** Idempotent npm archive publication for release recovery. */
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import * as exec from "@dbx-tools/core/exec";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { TaskDryRunOptionSchema } from "./options.ts";
import { runTaskCommand } from "../src/_task-command.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const logger = log.logger("projen:publish-npm");

/** Registry and archive identity used to verify idempotent npm publication. */
export interface NpmReleaseIdentity {
  readonly access?: "public" | "restricted";
  readonly contentDigest?: string;
  readonly integrity?: string;
  readonly name: string;
  readonly repository?: unknown;
  readonly version: string;
}

interface NpmArchiveManifest {
  readonly [key: string]: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly publishConfig?: { readonly access?: unknown };
  readonly repository?: unknown;
  readonly version?: string;
}

/** Transform applied to a packed npm manifest before archive verification. */
export type NpmArchiveManifestTransform = (
  manifest: NpmArchiveManifest,
) => Readonly<Record<string, unknown>>;

/** Entry-point fields projected from publishConfig into a packed manifest. */
const PUBLISH_CONFIG_ENTRY_FIELDS = ["main", "types", "bin", "exports"] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Replace workspace and catalogue protocols with publishable registry ranges. */
export function materializeWorkspaceManifest(
  source: Readonly<Record<string, unknown>>,
  workspace: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const manifest = structuredClone(source) as Record<string, unknown>;
  const version = workspace.version;
  const catalog =
    workspace.catalog && typeof workspace.catalog === "object"
      ? (workspace.catalog as Readonly<Record<string, unknown>>)
      : {};
  if (typeof version !== "string" || !version) {
    throw new Error("Workspace manifest has no version");
  }
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    manifest[field] = Object.fromEntries(
      Object.entries(dependencies).map(([name, value]) => [
        name,
        materializeDependency(name, value, version, catalog),
      ]),
    );
  }
  return manifest;
}

function materializeDependency(
  name: string,
  value: unknown,
  version: string,
  catalog: Readonly<Record<string, unknown>>,
): unknown {
  if (value === "catalog:") {
    const resolved = catalog[name];
    if (typeof resolved !== "string" || !resolved) {
      throw new Error(`Workspace catalog has no version for ${name}`);
    }
    return resolved;
  }
  if (typeof value !== "string" || !value.startsWith("workspace:")) return value;
  const selector = value.slice("workspace:".length);
  if (selector === "*" || !selector) return version;
  if (selector === "^" || selector === "~") return `${selector}${version}`;
  return selector;
}

/**
 * Fold compiled publish entry points onto an archive manifest without changing
 * the source checkout.
 */
export function applyPublishConfig(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const manifest = { ...source };
  const publishConfig = manifest.publishConfig as Record<string, unknown> | undefined;
  if (!publishConfig) return manifest;
  for (const field of PUBLISH_CONFIG_ENTRY_FIELDS) {
    if (field in publishConfig) manifest[field] = publishConfig[field];
  }
  return manifest;
}

function archiveFileEntries(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? archiveFileEntries(join(directory, entry.name), relativePath)
      : [relativePath];
  });
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

/** Verify that registry metadata represents the exact locally packed release. */
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

/** Read one published npm release identity, or `undefined` when it is absent. */
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
    const temp = mkdtempSync(join(tmpdir(), "projen-published-npm-"));
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

function readNpmArchiveManifest(path: string): NpmArchiveManifest {
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
  return JSON.parse(result.stdout) as NpmArchiveManifest;
}

/** Read and hash the release identity embedded in an npm archive. */
export function readNpmArchiveIdentity(path: string): NpmReleaseIdentity {
  const manifest = readNpmArchiveManifest(path);
  if (!manifest.name || !manifest.version) {
    throw new Error(`npm archive has no package name or version: ${path}`);
  }
  const access = manifest.publishConfig?.access;
  if (access !== undefined && access !== "public" && access !== "restricted") {
    throw new Error(`npm archive has invalid publishConfig.access: ${String(access)}`);
  }
  return {
    ...(access ? { access } : {}),
    contentDigest: npmArchiveContentDigest(path),
    integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`,
    name: manifest.name,
    repository: manifest.repository,
    version: manifest.version,
  };
}

function orderNpmArchives(archives: readonly string[]): string[] {
  const byName = new Map(
    archives.map((archive) => {
      const manifest = readNpmArchiveManifest(archive);
      if (!manifest.name) throw new Error(`npm archive has no package name: ${archive}`);
      return [manifest.name, { archive, manifest }] as const;
    }),
  );
  if (byName.size !== archives.length) throw new Error("Release contains duplicate npm packages");
  const remaining = new Map(
    [...byName].map(([name, value]) => [
      name,
      new Set(
        [
          ...Object.keys(value.manifest.dependencies ?? {}),
          ...Object.keys(value.manifest.optionalDependencies ?? {}),
        ].filter((dependency) => byName.has(dependency)),
      ),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `Cyclic npm release dependencies: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    for (const name of ready) {
      ordered.push(byName.get(name)!.archive);
      remaining.delete(name);
    }
    for (const dependencies of remaining.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }
  return ordered;
}

/** Hash paths, executable bits, symlink targets, and bytes while ignoring tar metadata. */
export function npmArchiveContentDigest(path: string): string {
  const temp = mkdtempSync(join(tmpdir(), "projen-npm-content-"));
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
        hash.update(`${name}\0${stat.mode & 0o111}\0`);
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

/** Pack one workspace package and optionally transform only its archived manifest. */
export function packNpmPackage(
  directory: string,
  destination: string,
  path = process.env.PATH ?? "",
  transformManifest?: NpmArchiveManifestTransform,
): string {
  const executable = process.versions.bun ? process.execPath : "bun";
  const manifest = join(directory, "package.json");
  const originalManifest = readFileSync(manifest, "utf8");
  const workspaceRoot = projectUtils.root(directory) ?? directory;
  const workspaceManifest = JSON.parse(
    readFileSync(join(workspaceRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const packedManifest = `${JSON.stringify(
    materializeWorkspaceManifest(
      JSON.parse(originalManifest) as Record<string, unknown>,
      workspaceManifest,
    ),
    null,
    2,
  )}\n`;
  const manifestMode = lstatSync(manifest).mode & 0o777;
  const restoreManifestMode = (manifestMode & 0o200) === 0;
  const existingArchives = new Set(readdirSync(destination));
  if (restoreManifestMode) chmodSync(manifest, manifestMode | 0o200);
  try {
    writeFileSync(manifest, packedManifest);
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
  } finally {
    writeFileSync(manifest, originalManifest);
    if (restoreManifestMode) chmodSync(manifest, manifestMode);
  }
  const archives = readdirSync(destination).filter(
    (file) => file.endsWith(".tgz") && !existingArchives.has(file),
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one packed npm archive, found ${archives.length}`);
  }
  const archive = join(destination, archives[0]);
  if (!transformManifest) return archive;

  const temp = mkdtempSync(join(tmpdir(), "projen-npm-project-"));
  try {
    exec.spawnSync("tar", ["-xzf", archive, "-C", temp], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
    const manifestPath = join(temp, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NpmArchiveManifest;
    writeFileSync(manifestPath, `${JSON.stringify(transformManifest(manifest), null, 2)}\n`);
    rmSync(archive, { force: true });
    exec.spawnSync("tar", ["-czf", archive, "-C", temp, ...archiveFileEntries(temp)], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
    return archive;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Publish dependency-ordered npm archives, skipping only exact registry matches. */
export async function publishNpmArchives(options: {
  readonly directory: string;
  readonly dryRun?: boolean;
  readonly registry?: string;
  readonly version?: string;
}): Promise<void> {
  const directory = resolve(options.directory);
  const archives = orderNpmArchives(
    readdirSync(directory)
      .filter((file) => file.endsWith(".tgz"))
      .sort()
      .map((file) => join(directory, file)),
  );
  if (archives.length === 0) throw new Error(`No npm archives found in ${directory}`);

  for (const archive of archives) {
    const local = readNpmArchiveIdentity(archive);
    if (options.version && local.version !== options.version) {
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
    runTaskCommand(process.cwd(), "npm", [
      "publish",
      archive,
      ...(local.access ? ["--access", local.access] : []),
      ...(options.registry ? ["--registry", options.registry] : []),
      ...(options.dryRun ? ["--dry-run"] : []),
    ]);
  }
}

/** Parse npm archive publication options and execute the publisher. */
export const PublishNpmOptionsSchema = z.object({
  directory: z.string().trim().min(1).describe("Directory containing npm archives"),
  version: z.string().trim().min(1).optional().describe("Expected npm release version"),
  registry: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("npm registry URL")
    .meta({ env: "NPM_CONFIG_REGISTRY" }),
  dryRun: TaskDryRunOptionSchema,
});

/** Parse task options and publish validated npm release archives. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = await taskOptions(
    taskCommand(import.meta.url, "Publish validated npm release archives", PublishNpmOptionsSchema),
    PublishNpmOptionsSchema,
    args,
  );
  await publishNpmArchives(options);
}

await runTaskMain(import.meta, main);
