#!/usr/bin/env -S bun
/**
 * `bun tasks/publish.ts <version> [--registry <url>] [--exclude <dir>] [--dry-run]`
 * - verify every workspace member and the Bun lock carry the release version,
 * then publish each package owned by the standard Node release with `bun publish`.
 *
 * Bun has no `pnpm -r publish`, so this loop is the recursive-publish stand-in.
 * It leans on native bun for everything bun already does:
 *
 *   - **version validation** fails when any member differs from the reviewed
 *     `VERSION`; publication never repairs committed release metadata;
 *   - **`workspace:` / `catalog:` rewriting** is NOT done here - `bun publish`
 *     strips both protocols in the PACKED tarball, resolving `workspace:*` to the
 *     sibling's version and `catalog:` to the root catalog entry. (Verified: a
 *     packed manifest shows `"@scope/x": "<version>"` and the real catalog range,
 *     while the on-disk manifest keeps the protocols.) Setting each member's
 *     version first is the only prerequisite, so a sibling resolves the release
 *     version. When Bun's workspace lock already carries the version, its
 *     refresh is skipped;
 *   - **`publishConfig` substitution** (compiled `lib/` entry points) is done
 *     HERE, by {@link applyPublishConfig}, NOT by bun: unlike pnpm/npm, `bun
 *     publish`/`bun pm pack` do NOT fold `publishConfig`'s `main`/`types`/`bin`/
 *     `exports` into the packed manifest (verified: the packed manifest keeps the
 *     raw `.ts` source paths and an inert `publishConfig`). Left unsubstituted, a
 *     published CLI's `bin` points at `./bin/x.ts`, and because the bin runs via
 *     its `#!/usr/bin/env node` shebang, node chokes on the `.ts`
 *     (ERR_UNKNOWN_FILE_EXTENSION). We merge `publishConfig` onto the top-level
 *     manifest before packing so the tarball advertises the compiled `lib/` tree;
 *   - **compiled output** is emitted once, before publishing, by one root-level
 *     filtered `bun run` that fans out to every publishable member in parallel.
 *     The later `bun publish --ignore-scripts` calls therefore pack the already
 *     compiled `lib/` trees instead of serially repeating each member's
 *     `prepack`. Packages retain their `prepack` task for standalone publishes.
 *   - **release recovery** packs each exact version before upload and compares
 *     its integrity and repository identity with registry metadata. A matching
 *     immutable version is skipped, while any mismatch fails the retry.
 *
 * `--dry-run` forwards to `bun publish`: it packs + validates
 * but uploads nothing, so the `release` workflow is testable end-to-end via a
 * `workflow_dispatch` run without anything reaching npm. `--registry` targets a
 * non-default registry (a local verdaccio); `--exclude <dir>` (repeatable,
 * repo-relative) skips a member owned by another publication flow.
 *
 * `--no-restore` keeps the transient publishConfig edits on disk instead of
 * undoing them at exit.
 *
 * The disk manifests carry the workspace `VERSION` (projen owns them, read-only);
 * this unlocks each only long enough to fold in the `publishConfig` entry points
 * and publish, then RESTORES every one it touched
 * byte-for-byte (and re-locks the mode) on the way out - see
 * {@link restoreManifests}. Restore returns each manifest to its committed
 * content, which already equals the release version, so the worktree is never
 * left regressed.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import ts from "typescript";
import { parse } from "yaml";
import {
  npmReleaseMatches,
  packNpmPackage,
  publishedNpmRelease,
  readNpmArchiveIdentity,
} from "./publish-npm.ts";

const logger = log.logger("dbx-tools:publish");

/** A manifest's on-disk bytes + mode, captured before this task edits it. */
interface ManifestBackup {
  readonly content: string;
  readonly mode: number;
}

/**
 * Original state of every manifest this task has unlocked, keyed by path.
 *
 * Bun does not apply `publishConfig` while packing, so publication temporarily
 * projects those entry points onto projen-owned manifests. The projection is
 * only meant for the packed tarball and is restored before the process exits.
 */
const manifestBackups = new Map<string, ManifestBackup>();

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

/** Whether every workspace member already carries the requested release version. */
function manifestsMatchVersion(members: readonly string[], version: string): boolean {
  return members.every((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version === version;
  });
}

/** Whether Bun's workspace lock records the requested version for every member. */
function lockfileMatchesVersion(
  root: string,
  members: readonly string[],
  version: string,
): boolean {
  const lockfile = join(root, "bun.lock");
  if (!existsSync(lockfile)) return false;
  try {
    const parsed = ts.parseConfigFileTextToJson(lockfile, readFileSync(lockfile, "utf8"));
    if (parsed.error) return false;
    const lock = parsed.config as {
      workspaces?: Record<string, { version?: string }>;
    };
    return members.every((dir) => {
      const relative = dir
        .slice(resolve(root).length + 1)
        .split("\\")
        .join("/");
      return lock.workspaces?.[relative]?.version === version;
    });
  } catch {
    return false;
  }
}

/** Spawn `command` in `cwd` with `PATH` overridden, failing the task on non-zero. */
function run(cwd: string, command: string, args: string[], path: string): void {
  const executable = command === "bun" && process.versions.bun ? process.execPath : command;
  exec.spawnSync(executable, args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
    env: { ...process.env, PATH: path },
  });
}

/** Asynchronous counterpart used for bounded parallel stamping and publishing. */
async function runAsync(cwd: string, command: string, args: string[], path: string): Promise<void> {
  const executable = command === "bun" && process.versions.bun ? process.execPath : command;
  await exec.spawn(executable, args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
    env: { ...process.env, PATH: path },
  });
}

/** Run independent jobs with a small fixed worker pool. */
async function runConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next++];
        await worker(value);
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/**
 * Make a projen-readonly manifest writable so the publishConfig projection can
 * edit it, recording its original bytes and mode for {@link restoreManifests}
 * the first time it is seen.
 */
function unlockManifest(pkgPath: string): void {
  const mode = statSync(pkgPath).mode;
  if (!manifestBackups.has(pkgPath)) {
    manifestBackups.set(pkgPath, { content: readFileSync(pkgPath, "utf8"), mode });
  }
  chmodSync(pkgPath, mode | 0o200);
}

/**
 * Put every manifest this task edited back exactly as it was found, mode included.
 *
 * Runs from an `exit` handler so a clean finish and a failure partway through the
 * publish loop are covered alike - a `bun publish` that dies on package 12 of 34
 * must not leave the first 11 projected. Best-effort per file: one unwritable
 * manifest is logged and the rest are still restored, since a partial restore
 * beats none.
 */
function restoreManifests(): void {
  for (const [pkgPath, backup] of manifestBackups) {
    try {
      chmodSync(pkgPath, backup.mode | 0o200);
      writeFileSync(pkgPath, backup.content);
      chmodSync(pkgPath, backup.mode);
    } catch (cause) {
      logger.warn(`could not restore ${pkgPath}`, { cause });
    }
  }
  manifestBackups.clear();
}

/** Entry-point fields projen writes as `.ts` source in-repo and rewrites to `lib/` for publish. */
const PUBLISH_CONFIG_ENTRY_FIELDS = ["main", "types", "bin", "exports"] as const;

/**
 * Fold a package's `publishConfig` entry-point fields onto the top-level manifest,
 * the way pnpm/npm do at pack time but `bun publish` does NOT (see the module
 * doc). Idempotent, writes only when something changes, and leaves `publishConfig`
 * in place (npm ignores it once the top-level fields already point at `lib/`). The
 * manifest must already be unlocked. {@link restoreManifests} puts the `.ts` entry
 * points back at exit, so this only ever affects the packed tarball.
 */
function applyPublishConfig(pkgPath: string): void {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined;
  if (!publishConfig) return;
  let changed = false;
  for (const field of PUBLISH_CONFIG_ENTRY_FIELDS) {
    if (field in publishConfig) {
      pkg[field] = publishConfig[field];
      changed = true;
    }
  }
  if (changed) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * PATH with the workspace-root `node_modules/.bin` prepended. The root-level
 * compile reaches each package's projen/dax task, which resolves `tsc` off PATH;
 * under the hoisted linker `tsc` lives only in the root `.bin`.
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
const concurrencyIdx = rest.indexOf("--concurrency");
const parsedConcurrency = Number(concurrencyIdx >= 0 ? rest[concurrencyIdx + 1] : 4);
if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1) {
  throw new Error(`--concurrency must be a positive integer, got ${String(parsedConcurrency)}`);
}
const concurrency = parsedConcurrency;
// Undo transient publishConfig edits at exit.
const restore = !rest.includes("--no-restore");
const excluded = new Set(
  rest.reduce<string[]>((acc, arg, i) => (arg === "--exclude" ? [...acc, rest[i + 1]] : acc), []),
);

const root = process.cwd();
const path = enrichedPath(root);
// Registered BEFORE the first manifest edit so no exit path can skip it: a clean
// finish and a `bun publish` failure mid-loop both land here, so a publish that
// dies partway does not leave half the workspace stamped.
if (restore) process.on("exit", restoreManifests);
const members = workspaceMembers(root)
  .filter((dir) => existsSync(join(dir, "package.json")))
  .filter((dir) => !excluded.has(resolve(root, dir).replace(`${resolve(root)}/`, "")));

// Publication consumes the reviewed version state and never repairs it.
if (!manifestsMatchVersion(members, version)) {
  throw new Error(`workspace manifests do not all match release version ${version}; run projen`);
}
logger.info(`all ${members.length} member manifests carry ${version}`);

// Ensure the lockfile resolves each `workspace:*` to the release version.
// `bun publish`/`pm pack` reads workspace versions from the LOCKFILE, not just
// live manifests. A normal bump's synth/install already makes it current; after
// fallback stamping, deleting it before install is what forces re-resolution.
const lockfile = join(root, "bun.lock");
if (lockfileMatchesVersion(root, members, version)) {
  logger.info(`workspace lock already resolves members at ${version}`);
} else {
  if (existsSync(lockfile)) rmSync(lockfile);
  logger.info("refreshing lockfile so workspace deps resolve to the release version");
  run(root, "bun", ["install"], path);
}

const publishArgs = [
  "--access",
  "public",
  "--ignore-scripts",
  ...(registry ? ["--registry", registry] : []),
  ...(dryRun ? ["--dry-run"] : []),
];
const publishable: Array<{ dir: string; name: string; compile: boolean }> = [];
for (const dir of members) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    private?: boolean;
    dbxToolsConfig?: { uniffi?: boolean };
    scripts?: Record<string, string>;
  };
  if (pkg.private) {
    logger.info(`skip private ${pkg.name ?? dirname(dir)}`);
    continue;
  }
  if (pkg.dbxToolsConfig?.uniffi === true) {
    logger.info(`skip UniFFI ${pkg.name ?? dirname(dir)}`);
    continue;
  }
  publishable.push({
    dir,
    name: pkg.name ?? dirname(dir),
    compile: Boolean(pkg.scripts && typeof pkg.scripts === "object" && "prepack" in pkg.scripts),
  });
}

const compiled = publishable.filter((pkg) => pkg.compile);
if (compiled.length > 0) {
  logger.info(`compiling ${compiled.length} publishable packages from the workspace root`);
  run(root, "bun", ["run", ...compiled.flatMap((pkg) => ["--filter", pkg.name]), "compile"], path);
}

// Compile against workspace source exports first. Switching manifests to their
// publishConfig entries before compilation makes consumers resolve sibling
// `lib/*.d.ts` files that have not been emitted yet in a clean checkout.
for (const { dir } of publishable) {
  const manifestPath = join(dir, "package.json");
  unlockManifest(manifestPath);
  applyPublishConfig(manifestPath);
}

logger.info(
  `${dryRun ? "dry-run packing" : "publishing"} ${publishable.length} packages with concurrency ${concurrency}`,
);
await runConcurrent(publishable, concurrency, async ({ dir, name }) => {
  if (!dryRun) {
    const packed = mkdtempSync(join(tmpdir(), "dbx-tools-npm-release-"));
    try {
      const archive = packNpmPackage(dir, packed, path);
      const local = readNpmArchiveIdentity(archive);
      if (local.name !== name || local.version !== version) {
        throw new Error(
          `Packed npm identity ${local.name}@${local.version} does not match ${name}@${version}`,
        );
      }
      const published = await publishedNpmRelease(local.name, local.version, registry);
      if (npmReleaseMatches(local, published)) {
        logger.info(`skip published ${name} @ ${version}`);
        return;
      }
    } finally {
      rmSync(packed, { recursive: true, force: true });
    }
  }
  logger.info(`${dryRun ? "dry-run publishing" : "publishing"} ${name} @ ${version}`);
  await runAsync(dir, "bun", ["publish", ...publishArgs], path);
});
logger.success(
  `${dryRun ? "dry-run: packed" : "published"} ${publishable.length} packages @ ${version}`,
);
