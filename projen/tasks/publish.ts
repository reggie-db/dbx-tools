#!/usr/bin/env -S bun
/**
 * `bun tasks/publish.ts <version> [--registry <url>] [--exclude <dir>] [--dry-run]`
 * - set a release version on every workspace member and publish each non-private
 * one with `bun publish`.
 *
 * Bun has no `pnpm -r publish`, so this loop is the recursive-publish stand-in.
 * It leans on native bun for everything bun already does:
 *
 *   - **version stamping** is `bun pm pkg set version=<version>` per member (bun's
 *     native package.json editor - idempotent, edits only that dir's manifest, no
 *     git side effects; `bun pm version` is for bumping and errors on an unchanged
 *     version, so `pkg set` is the right tool for an exact release value);
 *   - **`workspace:` / `catalog:` rewriting** is NOT done here - `bun publish`
 *     strips both protocols in the PACKED tarball, resolving `workspace:*` to the
 *     sibling's version and `catalog:` to the root catalog entry. (Verified: a
 *     packed manifest shows `"@scope/x": "<version>"` and the real catalog range,
 *     while the on-disk manifest keeps the protocols.) Setting each member's
 *     version first is the only prerequisite, so a sibling resolves the release
 *     version rather than the disk default of `0.0.0`;
 *   - **`publishConfig` substitution** (compiled `lib/` entry points) and the
 *     `prepack` (compile) run are `bun publish`'s own pack behavior.
 *
 * `--dry-run` forwards to `bun publish`: it packs + validates (running prepack)
 * but uploads nothing, so the `release` workflow is testable end-to-end via a
 * `workflow_dispatch` run without anything reaching npm. `--registry` targets a
 * non-default registry (a local verdaccio); `--exclude <dir>` (repeatable,
 * repo-relative) skips a member that releases on its OWN tag namespace (e.g.
 * `projen`, published by `projen-release`, not the main `release`).
 *
 * The disk manifests normally carry `version: 0.0.0` (projen owns them, read-only);
 * this unlocks each only long enough to set the version + publish. The next
 * `projen` synth restores them - the release version lives in the git tag.
 */
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";

const logger = log.logger("dbx-tools:publish");

/**
 * Workspace member dirs (absolute), read from the root `pnpm-workspace.yaml` - the
 * file the engine keeps for the Databricks Apps pnpm deploy, which also lists every
 * bun workspace member. (`bun pm ls` reports installed deps, not the member globs,
 * so the manifest list is the source of truth.)
 */
function workspaceMembers(root: string): string[] {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as { packages?: string[] } | null;
  return (doc?.packages ?? []).map((m) => resolve(root, m));
}

/** Spawn `command` in `cwd` with `PATH` overridden, failing the task on non-zero. */
function run(cwd: string, command: string, args: string[], path: string): void {
  exec.spawnSync(command, args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
    env: { ...process.env, PATH: path },
  });
}

/** Make a projen-readonly manifest writable so `bun pm pkg set` / `bun publish` can edit it. */
function unlockManifest(pkgPath: string): void {
  chmodSync(pkgPath, statSync(pkgPath).mode | 0o200);
}

/**
 * PATH with the workspace-root `node_modules/.bin` prepended. `bun publish` runs
 * each package's `prepack` (compile) through projen's dax shell, which resolves
 * `tsc` off PATH - but under the hoisted linker `tsc` lives ONLY in the root
 * `.bin`, not a per-package one, so without this the compile fails with
 * `dax: tsc: command not found`. (In CI `bun install` already puts it there; this
 * makes the task self-sufficient when invoked directly too.)
 */
function enrichedPath(root: string): string {
  const binDir = join(root, "node_modules", ".bin");
  const current = process.env.PATH ?? "";
  return current.split(":").includes(binDir) ? current : `${binDir}:${current}`;
}

const [version, ...rest] = process.argv.slice(2);
if (!version) {
  logger.error(
    "usage: bun tasks/publish.ts <version> [--registry <url>] [--exclude <dir>] [--dry-run]",
  );
  process.exit(1);
}
const registryIdx = rest.indexOf("--registry");
const registry = registryIdx >= 0 ? rest[registryIdx + 1] : undefined;
const dryRun = rest.includes("--dry-run");
// `--stamp-only`: set versions + refresh the lockfile, then STOP (no publish).
// The standalone `projen-release` uses this to version-stamp the workspace so its
// own `bun publish` (run separately, in `projen/`) resolves `workspace:*` siblings
// to the release version; publishing every member here would double-publish them.
const stampOnly = rest.includes("--stamp-only");
const excluded = new Set(
  rest.reduce<string[]>((acc, arg, i) => (arg === "--exclude" ? [...acc, rest[i + 1]] : acc), []),
);

const root = process.cwd();
const path = enrichedPath(root);
const members = workspaceMembers(root)
  .filter((dir) => existsSync(join(dir, "package.json")))
  .filter((dir) => !excluded.has(resolve(root, dir).replace(`${resolve(root)}/`, "")));

// Set the version on EVERY member first (native `bun pm pkg set`), so a sibling
// published later has its `workspace:*` dep resolved to the release version - not
// the disk default of 0.0.0 - by `bun publish`'s own protocol rewriting.
logger.info(`setting ${version} across ${members.length} members`);
for (const dir of members) {
  unlockManifest(join(dir, "package.json"));
  run(dir, "bun", ["pm", "pkg", "set", `version=${version}`], path);
}

// Refresh the lockfile so `bun publish` resolves each `workspace:*` to the version
// just set. `bun publish`/`pm pack` reads the workspace version from the LOCKFILE,
// not the live manifest, and a plain `bun install` (even `--force`) does NOT
// re-resolve it after only a version-field change - deleting the lockfile first
// does. Without this every `workspace:*` dep would publish as the stale `0.0.0`.
const lockfile = join(root, "bun.lock");
if (existsSync(lockfile)) rmSync(lockfile);
logger.info("refreshing lockfile so workspace deps resolve to the release version");
run(root, "bun", ["install"], path);

if (stampOnly) {
  logger.success(`stamped ${members.length} members @ ${version} (no publish)`);
  process.exit(0);
}

const publishArgs = [
  "--access",
  "public",
  ...(registry ? ["--registry", registry] : []),
  ...(dryRun ? ["--dry-run"] : []),
];
let published = 0;
for (const dir of members) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    private?: boolean;
  };
  if (pkg.private) {
    logger.info(`skip private ${pkg.name ?? dirname(dir)}`);
    continue;
  }
  logger.info(`${dryRun ? "dry-run publishing" : "publishing"} ${pkg.name} @ ${version}`);
  run(dir, "bun", ["publish", ...publishArgs], path);
  published += 1;
}
logger.success(`${dryRun ? "dry-run: packed" : "published"} ${published} packages @ ${version}`);
