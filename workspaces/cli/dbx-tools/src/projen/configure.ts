/**
 * `configureProjen(options)` - constructs a projen `NodeProject` and turns it
 * into an env-enforcing pnpm monorepo.
 *
 * The engine has its own opinionated `NodeProject` defaults (see
 * {@link ENGINE_DEFAULTS}); `options.extends` overrides any of them, and anything
 * left undefined there falls back to the default, so a consuming `.projenrc.ts`
 * never repeats the baseline.
 *
 * Discovery is automatic: under each {@link ConfigureProjenOptions.workspacePackageRoots}
 * root, every `src`-bearing folder is a package. Its path relative to the root
 * yields cumulative-join env candidates (`ui/app` -> `[ui, ui-app]`), matched
 * against {@link ConfigureProjenOptions.workspacePackageEnvPaths} (default: identity
 * over the env names) to resolve the applied env(s) - possibly NONE, in which case
 * the agnostic default applies. The matched {@link WorkspaceEnvDef}s are merged and
 * spread into the subproject; the resolved env names are recorded on the project as
 * `workspacePackageEnvs` and passed to the `workspacePackage` hook via `spec.envs`.
 * `pnpm-workspace.yaml` (the SOURCE OF TRUTH every other command reads back) sources
 * its members from `project.subprojects`, so a package configured MANUALLY with
 * `applyEnv` - without auto-discovery - lands there too.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Component, javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import {
  DEFAULT_WORKSPACE_ENV,
  WORKSPACE_ENVS,
  type WorkspaceEnv,
  type WorkspaceEnvDef,
  workspaceEnvConfig,
} from "./envs";
import * as files from "./files";
import {
  type WorkspacePackageModifier,
  applyEnv,
  lockPackageJson,
  npmNameOf,
} from "./packages";
import {
  DEFAULT_WORKSPACE_PACKAGE_ROOTS,
  type OneOrMany,
  discoverPackages,
  projectName,
  toArray,
  toPosix,
} from "./workspace";

export type { ModifyPnpmWorkspace, PnpmWorkspaceConfig } from "./files";

/**
 * The pnpm `catalog:` version registry: dependency name -> version range. This is
 * a pnpm-workspace feature (packages reference it via a `catalog:` specifier), so
 * there is no projen type for it - it's just a string map.
 */
export type Catalog = Record<string, string>;

/** Default pnpm `catalog:` versions, pinned to match `databricks apps init` (AppKit). */
export const DEFAULT_CATALOG: Catalog = {
  react: "^19.2.4",
  "react-dom": "^19.2.4",
  "@types/react": "^19.2.2",
  "@types/react-dom": "^19.2.2",
  vite: "^7.1.14",
  "@vitejs/plugin-react": "^5.0.4",
  "@types/node": "^24.6.0",
  "@types/express": "^5.0.5",
  express: "^5.1.0",
  zod: "^4.3.6",
  typescript: "^5.9.3",
  commander: "^15.0.0",
  "@clack/prompts": "^1.7.0",
  "openapi-fetch": "^0.17.0",
  tsoa: "^6.6.0",
  pnpm: "^11.0.6",
};

/**
 * The engine's opinionated `NodeProject` defaults: pnpm, no jest/eslint/
 * prettier/github/release/depsUpgrade (this repo brings its own toolchain), and
 * no `devEngines.packageManager` (pnpm 11 errors if both that and
 * `packageManager` are set). `options.extends` overrides any of these; `name`
 * is resolved and applied separately (see {@link configureProjen}) so it is
 * always a `string`, never left to chance in the merge.
 */
const ENGINE_DEFAULTS: Partial<javascript.NodeProjectOptions> = {
  defaultReleaseBranch: "main",
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcJs: false,
  buildWorkflow: false,
  release: false,
  jest: false,
  prettier: false,
  github: false,
  npmignoreEnabled: false,
  licensed: false,
  entrypoint: "",
  depsUpgrade: false,
  peerDependencyOptions: { pinnedDevDependency: false },
  addPackageManagerToDevEngines: false,
};

export interface ConfigureProjenOptions {
  /**
   * Root project name; also the npm scope for generated package names
   * (`@<name>/<env>-<pkg>`). Auto-detected (git remote -> folder name) if omitted.
   */
  readonly name?: string;
  /**
   * Overrides for the underlying `NodeProject` construction. Anything set here
   * wins over {@link ENGINE_DEFAULTS}; anything left `undefined` falls back to
   * them - so a consuming `.projenrc.ts` only needs to mention what it wants to
   * change, not re-declare the whole opinionated baseline.
   */
  readonly extends?: Partial<javascript.NodeProjectOptions>;
  /**
   * Roots scanned for packages (each `src`-bearing folder under a root is one).
   * Defaults to {@link DEFAULT_WORKSPACE_PACKAGE_ROOTS} (`["workspaces"]`).
   */
  readonly workspacePackageRoots?: readonly string[];
  /**
   * Maps a package path token (a cumulative-join env candidate like `ui` or
   * `ui-app`) to the env name(s) that apply there. A package's candidates are
   * looked up here and the union of matches becomes its applied envs. Defaults to
   * an identity map over the (effective) env names, so `workspaces/ui/app` -> env
   * `ui`. Matching may yield NO envs.
   */
  readonly workspacePackageEnvPaths?: Record<string, OneOrMany<WorkspaceEnv>>;
  /** Env name -> config map. Defaults to the built-in {@link WORKSPACE_ENVS}. */
  readonly workspaceEnvs?: Record<string, WorkspaceEnvDef>;
  /** Envs to turn off (removed from the env map and the default path->env identity). */
  readonly disableWorkspaceEnvs?: WorkspaceEnv[];
  /** pnpm `catalog:` versions. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /**
   * Per-workspace-package hook to tweak each discovered subproject: add deps,
   * tasks, a bin, etc. via projen's own API. Dispatch on the stable
   * `spec.envs`/`spec.name`. Runs after the env configs are applied.
   */
  readonly workspacePackage?: WorkspacePackageModifier;
  /** Hook to tweak the assembled `pnpm-workspace.yaml` object (members, catalog, ...). */
  readonly pnpmWorkspace?: files.ModifyPnpmWorkspace;
}

/**
 * Regenerates every package's root `index.ts` barrel after synth - "barrels on
 * resynth" for the plain `projen` path. projen only runs `postSynthesize` when
 * `PROJEN_DISABLE_POST` is unset, so this is skipped during the watch loop's
 * `runSynth` (which sets it); there `dbxtools` calls `generateBarrels()` directly.
 */
class GeneratedBarrels extends Component {
  public override postSynthesize(): void {
    generateBarrels();
  }
}

/**
 * A devDep entry that keeps the engine itself resolvable for the *next* synth,
 * so a consumer's `.projenrc.ts` (which imports `configureProjen` from the
 * published package) doesn't lose that dependency the moment `configureProjen`
 * rebuilds `package.json` from its own declared deps - the caller only added it
 * manually (`pnpm add -D @dbx-tools/cli`) once, before `.projenrc.ts` existed to
 * declare it itself.
 *
 * Resolved from the engine's OWN nearby `package.json` (two levels up from this
 * file) for its name. Returns `undefined` when this code is running as plain
 * in-repo SOURCE rather than an installed dependency (this repo's own dogfooding
 * setup) - detected by whether the resolved path passes through a `node_modules`
 * segment at all, not by directory nesting (an installed copy is *always* nested
 * under the consuming project's own root; that alone doesn't distinguish it).
 *
 * Reuses whatever specifier the CURRENT `package.json` already has for that name
 * - `file:`, `link:`, an exact version, a range, whatever `pnpm add` was given -
 * rather than computing one: overwriting a caller's `file:`/`link:` install with a
 * version range would silently re-point it at the registry. Only a package.json
 * with no existing entry falls back to a computed `^<version>` pin.
 */
function engineSelfDependency(project: javascript.NodeProject): string | undefined {
  const enginePkgJson = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  if (!toPosix(enginePkgJson).includes("/node_modules/")) return undefined;
  let name: string, version: string;
  try {
    ({ name, version } = JSON.parse(readFileSync(enginePkgJson, "utf8")));
  } catch {
    return undefined;
  }

  const consumerPkgJson = join(resolve(project.outdir), "package.json");
  try {
    const consumer = JSON.parse(readFileSync(consumerPkgJson, "utf8"));
    const existing = consumer.devDependencies?.[name] ?? consumer.dependencies?.[name];
    if (existing) return `${name}@${existing}`;
  } catch {
    // No existing package.json (or no entry for it) - fall through to a computed pin.
  }
  return `${name}@^${version}`;
}

/** Construct and configure the monorepo project. The caller runs `.synth()`. */
export function configureProjen(options: ConfigureProjenOptions = {}): javascript.NodeProject {
  const {
    name: explicitName,
    extends: extendsOptions,
    workspacePackageRoots = DEFAULT_WORKSPACE_PACKAGE_ROOTS,
    workspacePackageEnvPaths,
    workspaceEnvs = WORKSPACE_ENVS,
    disableWorkspaceEnvs = [],
    catalog = DEFAULT_CATALOG,
    workspacePackage,
    pnpmWorkspace,
  } = options;

  // Resolve the project name up front (git remote -> folder name), so it's a real
  // string by the time the project is constructed. Also the npm scope for names.
  const name = explicitName ?? npmNameOf(projectName());

  const project = new javascript.NodeProject({
    ...ENGINE_DEFAULTS,
    ...extendsOptions,
    name,
  });

  const effectiveEnvs: Record<string, WorkspaceEnvDef> = { ...workspaceEnvs };
  for (const e of disableWorkspaceEnvs) delete effectiveEnvs[e];

  // path token -> env name(s). Default: identity over the effective env names, so
  // a package at `<root>/ui/app` (candidate `ui`) resolves to env `ui`.
  const envPaths: Record<string, OneOrMany<string>> =
    workspacePackageEnvPaths ?? Object.fromEntries(Object.keys(effectiveEnvs).map((k) => [k, k]));

  /** Union (ordered, deduped) of env names matched by a package's candidates; may be []. */
  const resolveEnvNames = (candidates: string[]): string[] => {
    const names: string[] = [];
    for (const candidate of candidates) {
      for (const envName of toArray(envPaths[candidate])) {
        if (!names.includes(envName)) names.push(envName);
      }
    }
    return names;
  };

  // Discover env packages by scanning the filesystem once (synth-time). The member
  // list, the subprojects, and the barrels all derive from this; every other
  // command reads the recorded list back from pnpm-workspace.yaml.
  const discovered = discoverPackages(resolve(project.outdir), workspacePackageRoots);

  // Run `.projenrc.ts` through tsx.
  new typescript.ProjenrcTs(project, { runner: typescript.TypeScriptRunner.tsx() });

  // Root devDeps the toolchain needs, plus the engine's own devDep entry (see
  // engineSelfDependency) so it stays resolvable for the next synth.
  const selfDep = engineSelfDependency(project);
  project.addDevDeps(
    ...(selfDep ? [selfDep] : []),
    "tsx@^4.23.0",
    "typescript@^5.9.3",
    "@types/node@^24.6.0",
  );

  const pkg = project.package;
  pkg.addField("type", "module");
  pkg.addField("private", true);
  // The root package.json is fully projen-owned here (deps/fields all come from
  // this file), so lock it read-only like the rest of the generated tree.
  lockPackageJson(project);

  // Hook into projen's own `watch` task (as projen repurposes it for cdk/jsii):
  // point it at the single CLI watch orchestrator (`pnpm dbxtools`).
  const watch = project.tasks.tryFind("watch") ?? project.addTask("watch");
  watch.reset("pnpm dbxtools sync --watch");

  // Root config files (all projen-owned: read-only + generated marker). The pnpm
  // workspace `packages` list is sourced from `project.subprojects` at synth (see
  // files.pnpmWorkspace) - so discovered AND any manual `applyEnv` packages land
  // there with no hardcoded member list.
  files.pnpmWorkspace(project, { catalog, modify: pnpmWorkspace });
  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.prettierConfig(project);
  files.prettierIgnore(project);
  files.vscodeTasks(project); // folderOpen -> `projen watch` -> `dbxtools sync --watch`
  files.vscodeSettings(project);
  files.vscodeExtensions(project);

  // Each discovered folder becomes a real projen TypeScriptProject subproject via
  // the same `applyEnv` primitive a caller uses manually. The matched env config(s)
  // are merged and applied; an unmatched package falls back to the agnostic default.
  for (const p of discovered) {
    const envNames = resolveEnvNames(p.envCandidates);
    const env = envNames.length
      ? envNames.map((n) => workspaceEnvConfig(n, effectiveEnvs))
      : DEFAULT_WORKSPACE_ENV;
    const packageName = npmNameOf(name, p.relPath);
    applyEnv(project, {
      outdir: p.memberPath,
      name: packageName,
      env,
      envNames,
      spec: { envs: envNames, name: p.name, packageName },
      workspacePackage,
    });
  }

  // Barrels regenerate on every (plain) synth.
  new GeneratedBarrels(project);

  project.gitignore.addPatterns(
    ".DS_Store",
    "dist",
    "**/dist",
    "*.tsbuildinfo",
    "node_modules/.cache",
    ".env",
    "tmp",
  );

  // Mark the barrels + the generated openapi env as generated in .gitattributes
  // (collapses them in PR diffs, excludes from language stats).
  for (const root of workspacePackageRoots) {
    project.annotateGenerated(`/${root}/**/index.ts`);
    project.annotateGenerated(`/${root}/openapi/**`);
  }

  return project;
}
