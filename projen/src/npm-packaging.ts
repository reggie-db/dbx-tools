/** Side-effect-free npm archive packing helpers. */
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawnSync, root } from "@dbx-tools/core";

import type { NpmArchiveManifest } from "./npm-release.ts";
import { materializeWorkspaceManifest } from "./workspace-manifest.ts";

/** Transform applied to a packed npm manifest before archive verification. */
export type NpmArchiveManifestTransform = (
  manifest: NpmArchiveManifest,
) => Readonly<Record<string, unknown>>;

const PUBLISH_CONFIG_ENTRY_FIELDS = ["main", "types", "bin", "exports"] as const;
const PACK_MODE_IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

interface PackageFileMode {
  readonly path: string;
  readonly mode: number;
}

function normalizePackageFileModes(directory: string): ReadonlyArray<PackageFileMode> {
  const changed: PackageFileMode[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!PACK_MODE_IGNORED_DIRECTORIES.has(entry.name)) {
          changed.push(...normalizePackageFileModes(join(directory, entry.name)));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(directory, entry.name);
      const mode = lstatSync(path).mode & 0o777;
      const normalizedMode = (mode & 0o111) === 0 ? 0o644 : 0o755;
      if (mode === normalizedMode) continue;
      chmodSync(path, normalizedMode);
      changed.push({ path, mode });
    }
    return changed;
  } catch (error) {
    for (const file of changed.reverse()) chmodSync(file.path, file.mode);
    throw error;
  }
}

/** Fold compiled publish entry points onto an archive manifest. */
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

/** Pack one workspace package and optionally transform its temporary manifest. */
export function packNpmPackage(
  directory: string,
  destination: string,
  path = process.env.PATH ?? "",
  transformManifest?: NpmArchiveManifestTransform,
): string {
  const executable = process.versions.bun ? process.execPath : "bun";
  const manifest = join(directory, "package.json");
  const originalManifest = readFileSync(manifest, "utf8");
  const workspaceRoot = root(directory) ?? directory;
  const workspaceManifest = JSON.parse(
    readFileSync(join(workspaceRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const materializedManifest = materializeWorkspaceManifest(
    JSON.parse(originalManifest) as Record<string, unknown>,
    workspaceManifest,
  );
  const packedManifest = `${JSON.stringify(
    transformManifest
      ? transformManifest(materializedManifest as NpmArchiveManifest)
      : materializedManifest,
    null,
    2,
  )}\n`;
  const existingArchives = new Set(readdirSync(destination));
  const changedModes = normalizePackageFileModes(directory);
  try {
    writeFileSync(manifest, packedManifest);
    spawnSync(
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
    try {
      writeFileSync(manifest, originalManifest);
    } finally {
      for (const file of [...changedModes].reverse()) chmodSync(file.path, file.mode);
    }
  }
  const archives = readdirSync(destination).filter(
    (file) => file.endsWith(".tgz") && !existingArchives.has(file),
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one packed npm archive, found ${archives.length}`);
  }
  return join(destination, archives[0]!);
}
