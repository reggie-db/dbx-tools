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
 *   - **`workspace:` / `catalog:` rewriting** is NOT done here - `bun pm pack`
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
 *     exact validated archive is passed to `npm publish`, so upload never
 *     repacks or repeats a member's `prepack`. Packages retain `prepack` for
 *     standalone publishes.
 *   - **release recovery** compares each packed archive's integrity and
 *     repository identity with registry metadata. A matching immutable version
 *     is skipped, while any mismatch fails the retry.
 *
 * `--dry-run` forwards to `npm publish`: it packs + validates
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
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { asyncUtils, log, object } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions, taskPositionals, taskRoot } from "./cli.ts";
import {
  TaskConcurrencyOptionSchema,
  TaskDirectoriesOptionSchema,
  TaskDryRunOptionSchema,
  TaskOutputOptionSchema,
  TaskRootOptionSchema,
} from "./options.ts";
import {
  applyPublishConfig,
  npmReleaseMatches,
  packNpmPackage,
  publishedNpmRelease,
  readNpmArchiveIdentity,
} from "./publish-npm.ts";
import { runTaskCommand, runTaskCommandAsync } from "../src/_task-command.ts";
import { recordedPackages } from "../src/packages.ts";

const logger = log.logger("projen:publish");

export { applyPublishConfig };

/** Whether selected workspace members carry the reviewed workspace version. */
function manifestsMatchVersion(members: readonly string[], version: string): boolean {
  return members.every((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version === version;
  });
}

/** Compiled files referenced by a publishConfig entry-point tree. */
function compiledPublishTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./lib/") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(compiledPublishTargets);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(compiledPublishTargets);
}

export function compiledPublishTargetExists(dir: string, target: string): boolean {
  if (!target.includes("*")) return existsSync(resolve(dir, target));
  const staticRoot = target.slice(0, target.indexOf("*")).replace(/\/+$/, "");
  return existsSync(resolve(dir, staticRoot));
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

function outputDirectory(root: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const output = resolve(root, value);
  const path = relative(root, output);
  if (!path || path.startsWith("..") || isAbsolute(path)) {
    throw new Error("--output must be a non-root directory inside the workspace");
  }
  return output;
}

export const PublishOptionsSchema = z.object({
  root: TaskRootOptionSchema,
  registry: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("npm registry URL")
    .meta({ env: "NPM_CONFIG_REGISTRY" }),
  output: TaskOutputOptionSchema,
  exclude: TaskDirectoriesOptionSchema.describe("Repeatable workspace directory to exclude"),
  dryRun: TaskDryRunOptionSchema,
  skipCompile: z.boolean().default(false).describe("Reuse already validated compiled output"),
  concurrency: TaskConcurrencyOptionSchema.default(4),
});

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = taskCommand(
    import.meta.url,
    "Build and publish the current npm workspace",
    PublishOptionsSchema,
  ).argument("<version>", "Workspace release version");
  const options = await taskOptions(command, PublishOptionsSchema, argv);
  const version = String(taskPositionals(command)[0]);
  const root = taskRoot(options.root);
  const output = outputDirectory(root, options.output);
  const { registry, dryRun, skipCompile, concurrency } = options;
  const excluded = new Set(options.exclude);

  const path = enrichedPath(root);
  const allMembers = recordedPackages(root)
    .map((pkg) => pkg.dir)
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
    const compiledTargets = [
      ...object.sequence(compiledPublishTargets(pkg.publishConfig)).distinct(),
    ];
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
          .filter((target) => !compiledPublishTargetExists(pkg.dir, target))
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
          "npm",
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
}

await runTaskMain(import.meta, main);
