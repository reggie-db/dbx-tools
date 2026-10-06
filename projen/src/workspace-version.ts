/**
 * Single source of truth for the workspace version.
 *
 * The repo-root `VERSION` file holds one plain `x.y.z` string that every
 * generated manifest copies at synth: the root and `projen/` package.json, every
 * JavaScript member, every Python `pyproject.toml`, and the example apps. Synth
 * only READS this file (defaulting to {@link DEFAULT_VERSION} when it is absent
 * on a fresh tree); it never rewrites it, so an ordinary `bunx projen` cannot
 * move a package version up or down.
 *
 * Only the pure `bump` task changes the number. It increments the checked-in
 * file while release preparation owns the surrounding Git transaction.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseVersion } from "semver";

/** Name of the repo-root file holding the workspace version. */
export const VERSION_FILE = "VERSION";

/** Version a fresh workspace reads before its first explicit VERSION write. */
export const DEFAULT_VERSION = "0.0.1";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** A parsed `[major, minor, patch]` tuple. */
export type Semver = [number, number, number];

/** Supported semantic release increments. */
export type VersionLevel = "patch" | "minor" | "major";

/** Parse an exact stable `x.y.z`, or `undefined` for prefixes, prereleases, or embedded versions. */
export function parseSemver(raw: string): Semver | undefined {
  const value = raw.trim();
  if (!SEMVER.test(value)) return undefined;
  const parsed = parseVersion(value);
  if (
    !parsed ||
    parsed.version !== value ||
    parsed.prerelease.length > 0 ||
    parsed.build.length > 0
  ) {
    return undefined;
  }
  return [parsed.major, parsed.minor, parsed.patch];
}

/** Ordering comparator: negative when `a < b`, positive when `a > b`, zero when equal. */
export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Increment a semantic version tuple by the requested release level. */
export function incrementSemver(version: Semver, level: VersionLevel): Semver {
  if (level === "major") return [version[0] + 1, 0, 0];
  if (level === "minor") return [version[0], version[1] + 1, 0];
  return [version[0], version[1], version[2] + 1];
}

/** Absolute path to the `VERSION` file for a workspace root. */
export function versionPath(root: string): string {
  return join(root, VERSION_FILE);
}

/**
 * Read the workspace version from `<root>/VERSION`. Returns {@link DEFAULT_VERSION}
 * when the file is absent (a fresh consumer tree). A file that EXISTS but does not
 * hold a valid `x.y.z` fails loudly rather than being silently "fixed" to a
 * different number during synth.
 */
export function readWorkspaceVersion(root: string): string {
  const path = versionPath(root);
  if (!existsSync(path)) return DEFAULT_VERSION;
  const raw = readFileSync(path, "utf8").trim();
  if (!parseSemver(raw)) {
    throw new Error(`${VERSION_FILE} must contain an x.y.z version, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Write the workspace version to `<root>/VERSION`. Only `bump` and bootstrap call this. */
export function writeWorkspaceVersion(root: string, version: string): void {
  if (!parseSemver(version)) {
    throw new Error(`workspace version must be x.y.z, got ${JSON.stringify(version)}`);
  }
  writeFileSync(versionPath(root), `${version}\n`);
}

/**
 * Synchronize one existing workspace manifest with the authoritative version.
 *
 * This covers workspace members that synthesize themselves and therefore are
 * not child projects of the root. Missing manifests are ignored so a freshly
 * bootstrapped extra member can create its package metadata independently.
 */
export function syncWorkspaceManifestVersion(manifestPath: string, version: string): boolean {
  if (!existsSync(manifestPath)) return false;
  const content = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(content) as Record<string, unknown>;
  if (manifest.version === version) return false;

  manifest.version = version;
  const { mode } = statSync(manifestPath);
  chmodSync(manifestPath, mode | 0o200);
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    chmodSync(manifestPath, mode);
  }
  return true;
}

/** Resolve the next release version without mutating the workspace. */
export function resolveNextVersion(
  root: string,
  level: VersionLevel,
): { base: string; version: string } {
  const base = readWorkspaceVersion(root);
  const parsed = parseSemver(base) ?? [0, 0, 1];
  return {
    base: parsed.join("."),
    version: incrementSemver(parsed, level).join("."),
  };
}
