/**
 * Bootstrap a brand-new folder into a working dbx-tools workspace before projen runs.
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { intro, outro } from "@clack/prompts";
import { exec, project } from "@dbx-tools/core";
import { json, log } from "@dbx-tools/shared-core";
import { childEnv, resolveBunArgv, runBun } from "./bun.ts";
import { rootLabel } from "./root.ts";

const logger = log.logger("dbx-tools:bootstrap");

/** Published package name used for Node's self-reference manifest resolution. */
const CLI_PACKAGE = "@dbx-tools/cli";

/** Fallback when this CLI's own version isn't a real release (an in-repo `0.0.0`). */
const FALLBACK_PROJEN_SPECIFIER = "@dbx-tools/projen@latest";

/**
 * Install the engine at THIS CLI's own version. The two are released together by
 * the root `bump`, so the matching engine always exists on the registry.
 *
 * Not `@latest`, and not a bare `@dbx-tools/projen`. A bare specifier can land on
 * a stray `0.0.0`, whose `^0.0.0` caret then reaches no real release. An explicit
 * range pinned to this CLI's own version admits only the matching engine, so the
 * CLI and the engine it drives never drift across a release (they are cut
 * together by the root `bump`).
 */
function defaultProjenSpecifier(): string {
  const version = ownVersion();
  return version ? `@dbx-tools/projen@^${version}` : FALLBACK_PROJEN_SPECIFIER;
}

/** This CLI's own released version, or `undefined` for an in-repo `0.0.0` build. */
function ownVersion(): string | undefined {
  try {
    // Resolve through the package's exported `./package.json`, which works from
    // both source (`src/bootstrap.ts`) and published output
    // (`lib/src/bootstrap.js`). A relative URL is one level from the manifest
    // in source but two levels away after compilation and silently fell back to
    // `@latest` in every installed CLI.
    const manifestPath = createRequire(import.meta.url).resolve(`${CLI_PACKAGE}/package.json`);
    const version = json.parseRecord(readFileSync(manifestPath, "utf8"))?.version;
    return typeof version === "string" && version !== "0.0.0" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Compare `x.y.z` triples; returns <0, 0, or >0. Missing parts count as 0. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Version of the engine currently installed at `root`, if any. */
function installedEngineVersion(root: string): string | undefined {
  try {
    const manifest = join(root, "node_modules", "@dbx-tools", "projen", "package.json");
    const version = json.parseRecord(readFileSync(manifest, "utf8"))?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Upgrade an established workspace whose installed engine predates this CLI.
 *
 * Bootstrapping pins the engine once, and nothing afterwards revisits it - so a
 * workspace created months ago kept resolving its original engine no matter how
 * current the CLI invoking it was, and failed inside the OLD engine's code
 * (`sync --watch` dying on a `concurrently` that engine never declared). The two
 * are released in lockstep, so this CLI's version is exactly the engine it
 * expects.
 *
 * Only ever moves FORWARD: an engine at or ahead of this CLI is left alone, so
 * an older CLI cannot downgrade a workspace.
 */
export function ensureEngineCurrent(root: string): void {
  const expected = ownVersion();
  if (!expected) return;
  const installed = installedEngineVersion(root);
  if (installed && compareVersions(installed, expected) >= 0) return;
  runBun(["add", "-D", defaultProjenSpecifier()], root);
}

// Reach the class through its module NAMESPACE. Current engines also hoist it
// flat, but every engine ever published exports the namespace, and this template
// is resolved against `@latest` - a flat import dies on an older one with
// "does not provide an export named 'DBXToolsNodeProject'".
const PROJENRC_TEMPLATE = `import { project as projectApi } from "@dbx-tools/projen";

const project = new projectApi.DBXToolsNodeProject();
project.synth();
`;

/**
 * Turn a folder into a functioning dbx-tools workspace: `bun init`, seed the
 * `package.json` workspace fields (bun reads `workspaces`/`trustedDependencies`
 * from the manifest), add `projen`/`typescript` + the engine package, write a
 * minimal `.projenrc.ts`, synth once (with `PROJEN_DISABLE_POST`), then install.
 * Does not run barrels - run `bun run barrels` or a full projen synth post-install
 * to generate package barrels.
 *
 * Every step is idempotent and self-guarded, so this is safe to run against a
 * folder that ALREADY has a hand-authored `.projenrc.ts` (and even a committed
 * `package.json`) but is missing the installed toolchain - e.g. a freshly copied
 * project whose generated files (including manifests) are gitignored. In that
 * case `bun init` and the `.projenrc.ts` scaffold are skipped, but the engine +
 * projen are (re)installed so the subsequent synth can regenerate everything.
 * See {@link seedToolchain}.
 */
export function bootstrapWorkspace(
  root: string,
  projenSpecifier: string = defaultProjenSpecifier(),
): void {
  intro(`Bootstrapping dbx-tools workspace in ${rootLabel(root)}`);

  seedToolchain(root, projenSpecifier);

  const projenrc = join(root, ".projenrc.ts");
  if (!existsSync(projenrc)) {
    writeFileSync(projenrc, PROJENRC_TEMPLATE);
  }

  runInitialSynth(root);

  runBun(["install"], root);
  outro("Workspace ready - re-run dbx-tools or add packages under packages/");
}

/**
 * Install the toolchain a synth needs (`projen`, `typescript`, and the dbx-tools
 * engine), seeding a `package.json` first when absent. bun reads its workspace
 * config (`workspaces`/`trustedDependencies`) from the manifest, so there is no
 * separate workspace file to seed - the engine writes `pnpm-workspace.yaml` at
 * synth for the Databricks Apps platform. Idempotent: run it whenever the engine
 * is missing, so a copied project with a `.projenrc.ts` but no
 * `node_modules`/manifest can be brought up to a synth-ready state.
 */
export function seedToolchain(
  root: string,
  projenSpecifier: string = defaultProjenSpecifier(),
): void {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    runBun(["init", "-y"], root);
    normalizeSeedManifest(manifestPath);
  }

  seedRegistry(root);

  const kernelArch = exec.spawnSync("uname", ["-m"], {
    stdin: "ignore",
    stdout: "capture",
    stderr: "ignore",
  }).stdout;
  logger.info("seeding toolchain", {
    node: process.version,
    bun: process.versions.bun,
    platform: process.platform,
    arch: process.arch,
    kernelArch: kernelArch || "unknown",
    engine: projenSpecifier,
  });
  runBun(["add", "-D", "projen", "typescript@^5.9.3", "@types/bun", projenSpecifier], root);
}

/**
 * Pin a non-default registry into the new root's `.npmrc`.
 *
 * The CLI already forces `--registry` onto the bun invocations it makes itself,
 * but a bootstrapped workspace outlives this process: every later `bun install`
 * the developer (or projen's post-synth step) runs is on its own. bun ignores
 * `npm_config_registry` from the environment, so without a file on disk those
 * runs revert to `https://registry.npmjs.org/` - which is a hard failure where
 * the custom registry was the only reachable one.
 *
 * Only writes for an actual override, never creates a file just to name npmjs,
 * and never overwrites an existing `.npmrc` (the developer's own wins).
 */
function seedRegistry(root: string): void {
  const registry = project.npmRegistry(null, { overrideOnly: true, envVars: true })?.toString();
  if (!registry) return;
  const npmrc = join(root, ".npmrc");
  if (existsSync(npmrc)) return;
  writeFileSync(npmrc, `registry=${registry}\n`);
}

/**
 * Make what `bun init` produced safe to synth against: force `type: "module"`
 * (bun runs `.projenrc.ts` fine either way, but projen's ESM sources and the
 * emitted config assume module type) and drop any `packageManager`/`devEngines`
 * field that would pin a different manager. projen regenerates the whole manifest
 * at synth, so this only has to hold the seed together long enough to get there.
 */
function normalizeSeedManifest(manifestPath: string): void {
  try {
    const manifest = json.parseRecord(readFileSync(manifestPath, "utf8"));
    if (!manifest) return;
    delete manifest.devEngines;
    delete manifest.packageManager;
    manifest.type = "module";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // A malformed/absent manifest here just means the later `bun add` recreates it.
  }
}

/**
 * Run the initial synth by executing `.projenrc.ts` directly with bun (with
 * `PROJEN_DISABLE_POST` set), NOT `projen <task>`. Use right after seeding a
 * fresh workspace: the projen TASKS (`sync`, `barrels`, ...) only exist once
 * `.projenrc.ts` has run once, so `projen sync` can't be the bootstrapping step.
 */
export function runInitialSynth(root: string): void {
  const [command, ...prefix] = resolveBunArgv();
  // bun runs the `.ts` directly. The registry reaches anything nested through
  // `childEnv` and the seeded `.npmrc`.
  exec.spawnSync(command, [...prefix, ".projenrc.ts"], {
    cwd: root,
    env: childEnv({ PROJEN_DISABLE_POST: "true" }),
    check: true,
  });
}
