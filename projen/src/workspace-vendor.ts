/** Workspace package vendoring for isolated AppKit deployment snapshots. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "@dbx-tools/shared-core";
import { applyPublishConfig, packNpmPackage } from "./npm-packaging.ts";
import { readPackageManifest, workspaceDependencyDirectories } from "./packages.ts";

const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Result of staging a workspace package dependency closure. */
export interface VendoredWorkspaceDependencies {
  readonly archives: readonly string[];
  readonly packages: readonly string[];
}

/** Whether a runtime manifest field contains a workspace protocol dependency. */
function _workspaceDependencyNames(manifest: Readonly<Record<string, unknown>>): string[] {
  return RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) return [];
    return Object.entries(dependencies).flatMap(([name, value]) =>
      typeof value === "string" && value.startsWith("workspace:") ? [name] : [],
    );
  });
}

/** Ensure generated archives survive the staged application's ignore rules. */
function _includeVendorArchives(application: string): void {
  const gitignore = join(application, ".gitignore");
  const before = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const lines = ["!/vendor/", "!/vendor/npm/", "!/vendor/npm/*.tgz"];
  const missing = lines.filter((line) => !before.split(/\r?\n/).includes(line));
  if (missing.length === 0) return;
  if (existsSync(gitignore)) chmodSync(gitignore, statSync(gitignore).mode | 0o200);
  writeFileSync(gitignore, `${before.replace(/\s*$/, "")}\n${missing.join("\n")}\n`);
}

/** Give a local package archive a content identity that invalidates installer caches. */
function _contentAddressArchive(archive: string): string {
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex").slice(0, 16);
  const addressed = join(dirname(archive), `${basename(archive, ".tgz")}-${digest}.tgz`);
  renameSync(archive, addressed);
  return addressed;
}

/**
 * Pack the transitive runtime workspace closure and link every archive directly
 * from the staged application manifest. Returns without writing when the source
 * application has no workspace protocol dependencies.
 */
export function vendorWorkspaceDependencies(
  sourceRoot: string,
  stageRoot: string,
  applicationPath: string,
): VendoredWorkspaceDependencies {
  const sourceApplication = resolve(sourceRoot, applicationPath);
  const sourceManifest = readPackageManifest(sourceApplication);
  if (!sourceManifest || typeof sourceManifest.name !== "string") {
    throw new Error(`Application package manifest is missing: ${sourceApplication}`);
  }
  const directWorkspaceDependencies = _workspaceDependencyNames(sourceManifest);
  if (directWorkspaceDependencies.length === 0) return { archives: [], packages: [] };

  const selected = workspaceDependencyDirectories(sourceManifest.name, sourceRoot)
    .filter((directory) => resolve(directory) !== sourceApplication)
    .map((directory) => {
      const manifest = readPackageManifest(directory);
      if (!manifest || typeof manifest.name !== "string") {
        throw new Error(`Workspace package manifest is missing: ${directory}`);
      }
      return { directory, name: manifest.name };
    });
  const selectedNames = new Set(selected.map(({ name }) => name));
  const unresolved = directWorkspaceDependencies.filter((name) => !selectedNames.has(name));
  if (unresolved.length > 0) {
    throw new Error(`Workspace dependencies are not recorded: ${unresolved.join(", ")}`);
  }

  const stagedApplication = resolve(stageRoot, applicationPath);
  const archiveDirectory = join(stagedApplication, "vendor", "npm");
  mkdirSync(archiveDirectory, { recursive: true });
  const links = Object.fromEntries(
    selected.map(({ directory, name }) => {
      const archive = _contentAddressArchive(
        packNpmPackage(directory, archiveDirectory, process.env.PATH, applyPublishConfig),
      );
      return [name, `file:./vendor/npm/${basename(archive)}`];
    }),
  );
  const stagedManifestPath = join(stagedApplication, "package.json");
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  const dependencies = isRecord(stagedManifest.dependencies) ? stagedManifest.dependencies : {};
  stagedManifest.dependencies = { ...dependencies, ...links };
  chmodSync(stagedManifestPath, statSync(stagedManifestPath).mode | 0o200);
  writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  _includeVendorArchives(stagedApplication);
  return {
    archives: Object.values(links),
    packages: selected.map(({ name }) => name),
  };
}
