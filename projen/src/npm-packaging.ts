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
  const manifestMode = lstatSync(manifest).mode & 0o777;
  const restoreManifestMode = (manifestMode & 0o200) === 0;
  const existingArchives = new Set(readdirSync(destination));
  if (restoreManifestMode) chmodSync(manifest, manifestMode | 0o200);
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
    writeFileSync(manifest, originalManifest);
    if (restoreManifestMode) chmodSync(manifest, manifestMode);
  }
  const archives = readdirSync(destination).filter(
    (file) => file.endsWith(".tgz") && !existingArchives.has(file),
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one packed npm archive, found ${archives.length}`);
  }
  return join(destination, archives[0]!);
}
