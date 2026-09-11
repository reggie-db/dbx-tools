/**
 * Single source of truth for the workspace version.
 *
 * The repo-root `VERSION` file holds one plain `x.y.z` string that every
 * generated manifest copies at synth: the root and `projen/` package.json, every
 * JS member, every Python `pyproject.toml`, the generated openapi packages, and
 * the example apps. Synth only READS this file (defaulting to {@link
 * DEFAULT_VERSION} when it is absent on a fresh tree); it never rewrites it, so an
 * ordinary `bunx projen` cannot move a package version up or down.
 *
 * Only two callers change the number: the pure `bump` task used while preparing
 * a reviewed release PR, and the one-time bootstrap of a workspace that has no
 * `VERSION` yet. Both resolve the base from remote git tags first ({@link
 * resolveRemoteVersion}) so a release cut elsewhere is respected, and fall back
 * to the local file (or {@link DEFAULT_VERSION}) when the remote is unreachable
 * or has no tags. The remote is consulted only on those paths.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "@dbx-tools/core";

/** Name of the repo-root file holding the workspace version. */
export const VERSION_FILE = "VERSION";

/** Version a fresh workspace starts at when no `VERSION` file and no remote tag exist. */
export const DEFAULT_VERSION = "0.0.1";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** A parsed `[major, minor, patch]` tuple. */
export type Semver = [number, number, number];

/** Supported semantic release increments. */
export type VersionLevel = "patch" | "minor" | "major";

/** Parse `x.y.z` (ignoring any leading `v`/prefix), or `undefined` when it does not match. */
export function parseSemver(raw: string): Semver | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
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
  if (!SEMVER.test(raw)) {
    throw new Error(`${VERSION_FILE} must contain an x.y.z version, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Write the workspace version to `<root>/VERSION`. Only `bump` and bootstrap call this. */
export function writeWorkspaceVersion(root: string, version: string): void {
  if (!SEMVER.test(version)) {
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

/** Run git in `cwd`, capturing stdout and swallowing failure (offline, no repo). */
function gitCapture(cwd: string, args: string[]): string {
  try {
    const res = exec.spawnSync("git", args, {
      cwd,
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    });
    return res.stdout?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Highest tag matching `<prefix><semver>` in the local tag list, or `undefined`. */
export function latestTagVersion(cwd: string, prefix: string): Semver | undefined {
  const out = gitCapture(cwd, [
    "-c",
    "versionsort.suffix=-",
    "tag",
    "--sort=-version:refname",
    "--list",
    `${prefix}*`,
  ]);
  for (const tag of out.split("\n")) {
    const v = parseSemver(tag.replace(prefix, ""));
    if (v) return v;
  }
  return undefined;
}

/**
 * Highest published version across every tag prefix, or `undefined` when the
 * remote is unreachable or no matching tag exists. Fetches tags first (best
 * effort) so a release made elsewhere is respected; a fetch failure just means
 * the local tag list is used, and callers fall back to the `VERSION` file.
 */
export function resolveRemoteVersion(
  cwd: string,
  prefixes: readonly string[],
  { fetch = true }: { fetch?: boolean } = {},
): string | undefined {
  if (fetch) gitCapture(cwd, ["fetch", "--tags", "--quiet"]);
  let best: Semver | undefined;
  for (const prefix of prefixes) {
    const v = latestTagVersion(cwd, prefix);
    if (v && (!best || compareSemver(v, best) > 0)) best = v;
  }
  return best ? best.join(".") : undefined;
}

/**
 * The base version a `bump` increments from: the highest remote tag if any exists
 * (a local file that is ahead does NOT win), else the local `VERSION` file, else
 * {@link DEFAULT_VERSION}.
 */
export function resolveBaseVersion(
  root: string,
  prefixes: readonly string[],
  options: { fetch?: boolean } = {},
): { version: string; source: "remote" | "local" } {
  const remote = resolveRemoteVersion(root, prefixes, options);
  if (remote) return { version: remote, source: "remote" };
  return { version: readWorkspaceVersion(root), source: "local" };
}

/** Resolve the next release version without mutating the workspace. */
export function resolveNextVersion(
  root: string,
  prefixes: readonly string[],
  level: VersionLevel,
  options: { fetch?: boolean } = {},
): { base: string; version: string; source: "remote" | "local" } {
  const base = resolveBaseVersion(root, prefixes, options);
  const parsed = parseSemver(base.version) ?? [0, 0, 1];
  return {
    base: parsed.join("."),
    version: incrementSemver(parsed, level).join("."),
    source: base.source,
  };
}

/**
 * Create the `VERSION` file when it does not yet exist, seeding it from the remote
 * tags (or {@link DEFAULT_VERSION} when the remote is unreachable / has no tag). An
 * existing file is left untouched - only `bump` moves an established version, so
 * bootstrap never upgrades or downgrades one. Returns the current version.
 */
export function ensureWorkspaceVersion(
  root: string,
  { prefixes = ["v"], fetch = true }: { prefixes?: readonly string[]; fetch?: boolean } = {},
): string {
  if (!existsSync(versionPath(root))) {
    writeWorkspaceVersion(root, resolveRemoteVersion(root, prefixes, { fetch }) ?? DEFAULT_VERSION);
  }
  return readWorkspaceVersion(root);
}
