/**
 * Bootstrap a brand-new folder into a working dbx-tools workspace before projen runs.
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intro, outro } from "@clack/prompts";
import { exec } from "@dbx-tools/core";
import { resolvePnpmArgv, runPnpm } from "./pnpm";
import { rootLabel } from "./root";

// Pin to `@latest` explicitly: a bare `@dbx-tools/projen` can land on a stray
// `0.0.0` (whose `^0.0.0` caret then can't reach any real release), leaving the
// workspace on a stale engine. `@latest` always takes the newest published.
const DEFAULT_PROJEN_SPECIFIER = "@dbx-tools/projen@latest";

const PROJENRC_TEMPLATE = `import { DBXToolsNodeProject } from "@dbx-tools/projen";

const project = new DBXToolsNodeProject();
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
 * install. Does not run barrels - run `dbxtools barrels` or a full projen synth
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
  projenSpecifier: string = DEFAULT_PROJEN_SPECIFIER,
): void {
  intro(`Bootstrapping dbx-tools workspace in ${rootLabel(root)}`);

  seedToolchain(root, projenSpecifier);

  const projenrc = join(root, ".projenrc.ts");
  if (!existsSync(projenrc)) {
    writeFileSync(projenrc, PROJENRC_TEMPLATE);
  }

  runInitialSynth(root);

  runPnpm(["install", "--no-frozen-lockfile", "--force"], root);
  outro("Workspace ready - re-run dbxtools or add packages under workspaces/");
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
  projenSpecifier: string = DEFAULT_PROJEN_SPECIFIER,
): void {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    runPnpm(["init"], root);
    // pnpm 11 `init` writes `devEngines.packageManager: { name: "pnpm",
    // onFail: "download" }`. Any npm-based tool later in the chain (an
    // `npx`/dlx fallback) then refuses with EBADDEVENGINES because its own
    // runner is npm, not pnpm. projen regenerates the whole manifest at synth
    // anyway, so drop the block from this throwaway seed.
    stripDevEngines(manifestPath);
  }

  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, WORKSPACE_SEED);
  }

  runPnpm(["add", "-D", "projen", "typescript@^5.9.3", "tsx@^4.23.0", projenSpecifier], root);
}

/** Remove the `devEngines` block pnpm `init` seeds, so npm-based tooling doesn't reject the manifest. */
function stripDevEngines(manifestPath: string): void {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifest.devEngines === undefined) return;
    delete manifest.devEngines;
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
