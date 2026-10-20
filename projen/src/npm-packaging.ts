/** Side-effect-free npm archive packing helpers. */
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

function archiveFileEntries(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? archiveFileEntries(join(directory, entry.name), relativePath)
      : [relativePath];
  });
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
  const workspaceRoot = root(directory) ?? directory;
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
  const archive = join(destination, archives[0]!);
  if (!transformManifest) return archive;

  const temp = mkdtempSync(join(tmpdir(), "projen-npm-project-"));
  try {
    spawnSync("tar", ["-xzf", archive, "-C", temp], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
    const manifestPath = join(temp, "package", "package.json");
    const archivedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NpmArchiveManifest;
    writeFileSync(
      manifestPath,
      `${JSON.stringify(transformManifest(archivedManifest), null, 2)}\n`,
    );
    rmSync(archive, { force: true });
    spawnSync("tar", ["-czf", archive, "-C", temp, ...archiveFileEntries(temp)], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return archive;
}
