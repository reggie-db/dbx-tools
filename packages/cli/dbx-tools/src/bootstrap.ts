/**
 * Bootstrap a brand-new folder into a working dbx-tools workspace before projen runs.
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { exec } from "@dbx-tools/core";
import { json } from "@dbx-tools/shared-core";
import { resolvePnpmArgv, runPnpm } from "./pnpm";
import { rootLabel } from "./root";

/** Fallback when this CLI's own version isn't a real release (an in-repo `0.0.0`). */
const FALLBACK_PROJEN_SPECIFIER = "@dbx-tools/projen@latest";

/**
 * Install the engine at THIS CLI's own version. The two are released together by
 * the root `bump`, so the matching engine always exists on the registry.
 *
 * Not `@latest`, and not a bare `@dbx-tools/projen`. A bare specifier can land on
 * a stray `0.0.0`, whose `^0.0.0` caret then reaches no real release. `@latest`
 * has a subtler failure: pnpm 11 applies a `minimumReleaseAge` delay, so for the
 * first day after a release it deliberately resolves a dist-tag to the newest
 * version OLDER than the threshold and merely notes the newer one
 * (`+ @dbx-tools/projen 0.1.24 (0.3.42 is available)`). A bootstrap run right
 * after a release therefore installed a months-old engine against a current CLI,
 * which is how `sync --watch` died on an engine predating its `concurrently`
 * dependency. An explicit range admits only the version we want, so the age
 * heuristic has nothing older to fall back to.
 */
function defaultProjenSpecifier(): string {
  try {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const version = json.parseRecord(readFileSync(manifestPath, "utf8"))?.version;
    return typeof version === "string" && version !== "0.0.0"
      ? `@dbx-tools/projen@^${version}`
      : FALLBACK_PROJEN_SPECIFIER;
  } catch {
    return FALLBACK_PROJEN_SPECIFIER;
  }
}

// Reach the class through its module NAMESPACE. Current engines also hoist it
// flat, but every engine ever published exports the namespace, and this template
// is resolved against `@latest` - a flat import dies on an older one with
// "does not provide an export named 'DBXToolsNodeProject'".
const PROJENRC_TEMPLATE = `import { project as projectApi } from "@dbx-tools/projen";

const project = new projectApi.DBXToolsNodeProject();
project.synth();
`;

/** Seed `pnpm-workspace.yaml` so the first \`pnpm add\` can allow esbuild non-interactively. */
const WORKSPACE_SEED = `packages: []
allowBuilds:
  esbuild: true
`;

/**
 * Turn a folder into a functioning dbx-tools workspace: `pnpm init`, seed
 * `pnpm-workspace.yaml`, add `projen`/`typescript`/`tsx` + the engine package,
 * write a minimal `.projenrc.ts`, synth once (with `PROJEN_DISABLE_POST`), then
 * install. Does not run barrels - run `pnpm run barrels` or a full projen synth
 * post-install to generate package barrels.
 *
 * Every step is idempotent and self-guarded, so this is safe to run against a
 * folder that ALREADY has a hand-authored `.projenrc.ts` (and even a committed
 * `package.json`) but is missing the installed toolchain - e.g. a freshly copied
 * project whose generated files (including manifests) are gitignored. In that
 * case `pnpm init` and the `.projenrc.ts` scaffold are skipped, but the engine +
 * projen + tsx are (re)installed so the subsequent synth can regenerate
 * everything. See {@link seedToolchain}.
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

  runPnpm(["install", "--no-frozen-lockfile", "--force"], root);
  outro("Workspace ready - re-run dbx-tools or add packages under packages/");
}

/**
 * Install the toolchain a synth needs (`projen`, `typescript`, `tsx`, and the
 * dbx-tools engine), seeding a `package.json` and `pnpm-workspace.yaml` first
 * when absent. Idempotent: run it whenever the engine is missing, so a copied
 * project with a `.projenrc.ts` but no `node_modules`/manifests can be brought
 * up to a synth-ready state without full bootstrapping.
 */
export function seedToolchain(
  root: string,
  projenSpecifier: string = defaultProjenSpecifier(),
): void {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    runPnpm(["init"], root);
    normalizeSeedManifest(manifestPath);
  }

  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, WORKSPACE_SEED);
  }

  runPnpm(["add", "-D", "projen", "typescript@^5.9.3", "tsx@^4.23.0", projenSpecifier], root);
}

/**
 * Make what `pnpm init` produced safe to synth against. Two corrections, both
 * because that output varies by pnpm version:
 *
 *   - drop `devEngines`, which pnpm 11 seeds as `packageManager: { name: "pnpm",
 *     onFail: "download" }`. Any npm-based tool later in the chain (an
 *     `npx`/dlx fallback) then refuses with EBADDEVENGINES, its runner being npm;
 *   - force `type: "module"`, which pnpm 11 writes and pnpm 10 does not. tsx
 *     picks the entry's format from the nearest manifest, so without it
 *     `.projenrc.ts` loads as CJS and the first dependency using top-level await
 *     dies on "not supported with the cjs output format".
 *
 * projen regenerates the whole manifest at synth, so this only has to hold the
 * seed together long enough to get there.
 */
function normalizeSeedManifest(manifestPath: string): void {
  try {
    const manifest = json.parseRecord(readFileSync(manifestPath, "utf8"));
    if (!manifest) return;
    delete manifest.devEngines;
    manifest.type = "module";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // A malformed/absent manifest here just means the later `pnpm add` recreates it.
  }
}

/**
 * Run the initial synth by executing `.projenrc.ts` directly with tsx (with
 * `PROJEN_DISABLE_POST` set), NOT `projen <task>`. Use right after seeding a
 * fresh workspace: the projen TASKS (`sync`, `barrels`, ...) only exist once
 * `.projenrc.ts` has run once, so `projen sync` can't be the bootstrapping step.
 */
export function runInitialSynth(root: string): void {
  const [command, ...prefix] = resolvePnpmArgv();
  exec.spawnSync(command, [...prefix, "exec", "tsx", ".projenrc.ts"], {
    cwd: root,
    env: { ...process.env, PROJEN_DISABLE_POST: "true" },
    check: true,
  });
}
