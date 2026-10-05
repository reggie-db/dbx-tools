#!/usr/bin/env -S bun
/**
 * `bun tasks/publish.ts <version> [--registry <url>] [--exclude <dir>] [--dry-run] [--skip-compile]`
 * - verify every workspace member carries the release version, then pack and
 * publish each package owned by the standard Node release.
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
 *   - **`publishConfig` substitution** (compiled `lib/` entry points) is done
 *     inside the temporary archive, NOT in the checkout: unlike pnpm/npm, `bun
 *     publish`/`bun pm pack` do NOT fold `publishConfig`'s `main`/`types`/`bin`/
 *     `exports` into the packed manifest (verified: the packed manifest keeps the
 *     raw `.ts` source paths and an inert `publishConfig`). Left unsubstituted, a
 *     published CLI's `bin` points at `./bin/x.ts`, and because the bin runs via
 *     its `#!/usr/bin/env node` shebang, node chokes on the `.ts`
 *     (ERR_UNKNOWN_FILE_EXTENSION). We merge `publishConfig` onto the top-level
 *     manifest after packing so the tarball advertises the compiled `lib/` tree;
 *   - **compiled output** is emitted once, before packing, by one root-level
 *     filtered `bun run` that fans out to every publishable member in parallel.
 *     Every package is then packed once with lifecycle scripts disabled. The
 *     exact validated archive is passed to `bun publish`, so upload never
 *     repacks or repeats a member's `prepack`. Packages retain `prepack` for
 *     standalone publishes.
 *   - **release recovery** compares each packed archive's integrity and
 *     repository identity with registry metadata. A matching immutable version
 *     is skipped, while any mismatch fails the retry.
 *
 * `--dry-run` forwards to `bun publish`: it packs + validates
 * but uploads nothing. `--registry` targets a non-default registry (a local
 * verdaccio); `--exclude <dir>` (repeatable, repo-relative) skips a member owned
 * by another publication flow.
 *
 * The checkout remains byte-for-byte unchanged. A stale manifest is a release
 * error rather than something publication repairs. Local lockfiles are ignored
 * because configured registries can leak into them.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { asyncUtils, log } from "@dbx-tools/shared-core";
import { parse } from "yaml";
import {
  npmReleaseMatches,
  packNpmPackage,
  publishedNpmRelease,
  readNpmArchiveIdentity,
} from "./publish-npm.ts";
import { runTaskCommand, runTaskCommandAsync } from "../src/_task-command.ts";

const logger = log.logger("projen:publish");

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

/** Whether selected workspace members carry the reviewed workspace version. */
function manifestsMatchVersion(members: readonly string[], version: string): boolean {
  return members.every((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version === version;
  });
}

/** Entry-point fields projen writes as `.ts` source in-repo and rewrites to `lib/` for publish. */
const PUBLISH_CONFIG_ENTRY_FIELDS = ["main", "types", "bin", "exports"] as const;

/** Compiled files referenced by a publishConfig entry-point tree. */
function compiledPublishTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./lib/") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(compiledPublishTargets);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(compiledPublishTargets);
}

/**
 * Fold a package's `publishConfig` entry-point fields onto the top-level manifest,
 * the way pnpm/npm do at pack time but `bun publish` does NOT (see the module
 * doc). The input is the temporary archive manifest, never the checkout.
 */
export function applyPublishConfig(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const pkg = { ...source };
  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined;
  if (!publishConfig) return pkg;
  for (const field of PUBLISH_CONFIG_ENTRY_FIELDS) {
    if (field in publishConfig) pkg[field] = publishConfig[field];
  }
  return pkg;
}

/**
 * PATH with the workspace-root `node_modules/.bin` prepended. The root-level
 * compile reaches each package's projen/dax task, which resolves `tsc` off PATH;
 * under the hoisted linker `tsc` lives only in the root `.bin`.
 */
function enrichedPath(root: string): string {
  const binDir = join(root, "node_modules", ".bin");
  const current = process.env.PATH ?? "";
  return current.split(delimiter).includes(binDir) ? current : `${binDir}${delimiter}${current}`;
}

const argv = process.argv.slice(2);
const version = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
const rest = version ? argv.slice(1) : argv;
const root = process.cwd();
if (!version) {
  logger.error(
    "usage: bun tasks/publish.ts <version> [--registry <url>] [--output <dir>] [--exclude <dir>] [--dry-run] [--skip-compile]",
  );
  process.exit(1);
}
const registryIdx = rest.indexOf("--registry");
const registry = registryIdx >= 0 ? rest[registryIdx + 1] : undefined;
const outputIdx = rest.indexOf("--output");
const output = outputIdx >= 0 ? resolve(root, rest[outputIdx + 1]) : undefined;
const dryRun = rest.includes("--dry-run");
const skipCompile = rest.includes("--skip-compile");
const concurrencyIdx = rest.indexOf("--concurrency");
const parsedConcurrency = Number(concurrencyIdx >= 0 ? rest[concurrencyIdx + 1] : 4);
if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1) {
  throw new Error(`--concurrency must be a positive integer, got ${String(parsedConcurrency)}`);
}
const concurrency = parsedConcurrency;
const excluded = new Set(
  rest.reduce<string[]>((acc, arg, i) => (arg === "--exclude" ? [...acc, rest[i + 1]] : acc), []),
);

const path = enrichedPath(root);
const allMembers = workspaceMembers(root)
  .filter((dir) => existsSync(join(dir, "package.json")))
  .filter((dir) => !excluded.has(resolve(root, dir).replace(`${resolve(root)}/`, "")));
const members = allMembers;

if (!manifestsMatchVersion(members, version)) {
  throw new Error(`workspace manifests do not match release ${version}; run projen`);
}
logger.info(`validated ${members.length} selected member manifests`);

const publishArgs = [
  "--ignore-scripts",
  ...(registry ? ["--registry", registry] : []),
  ...(dryRun ? ["--dry-run"] : []),
];
const publishable: Array<{
  dir: string;
  name: string;
  version: string;
  compile: boolean;
  compiledTargets: string[];
  access?: "public" | "restricted";
}> = [];
for (const dir of members) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    publishConfig?: { access?: unknown };
  };
  if (pkg.private) {
    logger.info(`skip private ${pkg.name ?? dirname(dir)}`);
    continue;
  }
  if (!pkg.version) throw new Error(`Missing package version for ${pkg.name ?? dirname(dir)}`);
  const access = pkg.publishConfig?.access;
  if (access !== undefined && access !== "public" && access !== "restricted") {
    throw new Error(
      `${pkg.name ?? dirname(dir)} has invalid publishConfig.access ${String(access)}`,
    );
  }
  const compiledTargets = [...new Set(compiledPublishTargets(pkg.publishConfig))];
  publishable.push({
    dir,
    name: pkg.name ?? dirname(dir),
    version: pkg.version,
    compile: compiledTargets.length > 0,
    compiledTargets,
    ...(access ? { access } : {}),
  });
}

const compiled = publishable.filter((pkg) => pkg.compile);
if (compiled.length > 0) {
  if (skipCompile) {
    const missing = compiled.flatMap((pkg) =>
      pkg.compiledTargets
        .filter((target) => !existsSync(resolve(pkg.dir, target)))
        .map((target) => `${pkg.name}:${target}`),
    );
    if (missing.length > 0) {
      throw new Error(
        `--skip-compile requires validated compiled output; missing ${missing.join(", ")}`,
      );
    }
    logger.info(`reusing validated compiled output for ${compiled.length} publishable packages`);
  } else {
    logger.info(`compiling ${compiled.length} publishable packages from the workspace root`);
    runTaskCommand(
      root,
      "bun",
      ["run", ...compiled.flatMap((pkg) => ["--filter", pkg.name]), "compile"],
      { env: { ...process.env, PATH: path } },
    );
  }
}

logger.info(
  `${output ? "packing" : dryRun ? "dry-run packing" : "publishing"} ${publishable.length} packages with concurrency ${concurrency}`,
);
if (output) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
}
await asyncUtils.mapConcurrent(
  publishable,
  async ({ dir, name, version: packageVersion, access }) => {
    const packed = mkdtempSync(join(tmpdir(), "projen-npm-release-"));
    try {
      const archive = packNpmPackage(dir, packed, path, applyPublishConfig);
      const local = readNpmArchiveIdentity(archive);
      if (local.name !== name || local.version !== packageVersion) {
        throw new Error(
          `Packed npm identity ${local.name}@${local.version} does not match ${name}@${packageVersion}`,
        );
      }
      if (local.access !== access) {
        throw new Error(
          `Packed npm access ${String(local.access)} does not match ${String(access)} for ${name}`,
        );
      }
      if (output) {
        const destination = join(output, archive.split(/[\\/]/).at(-1)!);
        if (existsSync(destination)) {
          throw new Error(`Duplicate npm archive name: ${destination}`);
        }
        copyFileSync(archive, destination);
        logger.info(`packed ${name} @ ${packageVersion}`);
        return;
      }
      if (!dryRun) {
        const published = await publishedNpmRelease(local.name, local.version, registry);
        if (npmReleaseMatches(local, published)) {
          logger.info(`skip published ${name} @ ${packageVersion}`);
          return;
        }
      }
      logger.info(`${dryRun ? "dry-run publishing" : "publishing"} ${name} @ ${packageVersion}`);
      await runTaskCommandAsync(
        dir,
        "bun",
        ["publish", ...(access ? ["--access", access] : []), ...publishArgs, archive],
        { env: { ...process.env, PATH: path } },
      );
    } finally {
      rmSync(packed, { recursive: true, force: true });
    }
  },
  { concurrency, errorMode: "settle" },
);
logger.success(
  `${output || dryRun ? "packed" : "published"} ${publishable.length} packages${output ? ` to ${output}` : ""}`,
);
