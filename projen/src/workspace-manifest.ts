/**
 * Workspace dependency protocol materialization for external npm consumers.
 *
 * @module
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface StoredManifest {
  readonly path: string;
  readonly mode: number;
  readonly text: string;
}

/** Replace workspace and catalogue protocols with concrete registry ranges. */
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
  const overrides =
    workspace.overrides && typeof workspace.overrides === "object"
      ? (workspace.overrides as Readonly<Record<string, unknown>>)
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
        materializeDependency(name, value, version, catalog, overrides),
      ]),
    );
  }
  return manifest;
}

/**
 * Materialize every generated workspace manifest for one external command and
 * restore exact bytes and permissions afterward.
 */
export async function withMaterializedWorkspaceManifests<T>(
  root: string,
  callback: () => Promise<T>,
): Promise<T> {
  const rootManifestPath = resolve(root, "package.json");
  const rootManifest = readManifest(rootManifestPath);
  const workspaces = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces.filter((value): value is string => typeof value === "string")
    : [];
  const originals = [
    rootManifestPath,
    ...workspaces.map((workspace) => resolve(root, workspace, "package.json")),
  ].map(storeManifest);

  try {
    for (const original of originals) {
      const source = JSON.parse(original.text) as Record<string, unknown>;
      writeManifest(original.path, materializeWorkspaceManifest(source, rootManifest));
    }
    return await callback();
  } finally {
    for (const original of originals) restoreManifest(original);
  }
}

/**
 * Copy tracked and non-ignored source into a temporary directory, materialize
 * its manifests, and keep that snapshot stable for one external command.
 */
export async function withStagedWorkspaceManifests<T>(
  root: string,
  callback: (stage: string) => Promise<T>,
): Promise<T> {
  const stage = mkdtempSync(join(tmpdir(), "dbx-tools-app-deploy-"));
  try {
    const listed = exec.spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "capture",
        stderr: "capture",
      },
    );
    if (listed.exitCode !== 0) {
      throw new Error(`Could not enumerate app source: ${listed.stderr}`);
    }
    for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
      const source = resolve(root, relativePath);
      if (!existsSync(source)) continue;
      const destination = resolve(stage, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, statSync(source).mode & 0o777);
    }
    const bundleState = resolve(root, ".databricks");
    if (existsSync(bundleState)) {
      cpSync(bundleState, resolve(stage, ".databricks"), { recursive: true });
    }
    return await withMaterializedWorkspaceManifests(stage, () => callback(stage));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function materializeDependency(
  name: string,
  value: unknown,
  version: string,
  catalog: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): unknown {
  const override = overrides[name];
  if (typeof override === "string" && override && !override.startsWith("$")) {
    return override;
  }
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

function readManifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function storeManifest(path: string): StoredManifest {
  return {
    path,
    mode: statSync(path).mode & 0o777,
    text: readFileSync(path, "utf8"),
  };
}

function writeManifest(path: string, manifest: Readonly<Record<string, unknown>>): void {
  chmodSync(path, 0o644);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function restoreManifest(manifest: StoredManifest): void {
  chmodSync(manifest.path, 0o644);
  writeFileSync(manifest.path, manifest.text);
  chmodSync(manifest.path, manifest.mode);
}
