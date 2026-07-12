/**
 * `configureProjen(options)` - constructs a projen `NodeProject` and turns it
 * into an env-enforcing pnpm monorepo.
 *
 * The engine has its own opinionated defaults for the underlying `NodeProject`
 * (no jest/eslint/prettier/github/release/depsUpgrade, pnpm as the package
 * manager, ...; see {@link ENGINE_DEFAULTS}). `options.extends` lets a caller
 * override any of them - anything left undefined there falls back to the
 * engine's default, so a consuming `.projenrc.ts` never needs to repeat this
 * list itself.
 *
 * Everything else is auto-detected from folders: under each `workspaceEnvPaths`
 * root, any `<env>/<name>` folder with a `src/` becomes a projen
 * `TypeScriptProject` subproject (via the exported `applyEnv` primitive)
 * configured from its env (see `./envs`). `pnpm-workspace.yaml` (the SOURCE OF
 * TRUTH every other command reads back) sources its members from
 * `project.subprojects`, so a package configured MANUALLY with `applyEnv` -
 * without auto-discovery - lands there too. Per-package tweaks go in the
 * `workspace` hook.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Component, javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import {
  WORKSPACE_ENVS,
  type WorkspaceEnv,
  type WorkspaceEnvDef,
  workspaceEnvConfig,
} from "./envs";
import * as files from "./files";
import { type WorkspaceModifier, applyEnv, lockPackageJson, npmNameOf } from "./packages";
import { DEFAULT_WORKSPACE_ENV_PATHS, discoverPackages, projectName, toPosix } from "./workspace";

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
   * Workspace-env roots to scan for `<env>/<name>` packages. Each root's immediate
   * subfolders are env names; a `<env>/<name>` folder with a `src/` holding a
   * module file is a package. Defaults to {@link DEFAULT_WORKSPACE_ENV_PATHS}
   * (`["workspaces"]`).
   */
  readonly workspaceEnvPaths?: readonly string[];
  /** Env -> config map. Defaults to the built-in {@link WORKSPACE_ENVS}. */
  readonly workspaceEnvs?: Record<string, WorkspaceEnvDef>;
  /** Envs to turn off (their folders fall back to the default/agnostic config). */
  readonly disableWorkspaceEnvs?: WorkspaceEnv[];
  /** pnpm `catalog:` versions. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /**
   * Per-package hook to tweak each discovered subproject (the workspace): add deps,
   * tasks, a bin, etc. via projen's own API. Dispatch on the stable `spec.env`/`spec.name`.
   */
  readonly workspace?: WorkspaceModifier;
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
 * file) for its name, not a hardcoded string. Returns `undefined` when this code
 * is running as plain in-repo SOURCE rather than an installed dependency (this
 * repo's own dogfooding setup: `.projenrc.ts` imports it by relative path and
 * never needs it as a real dependency) - detected by whether the resolved path
 * passes through a `node_modules` segment at all, not by directory nesting (an
 * installed copy is *always* nested under the consuming project's own root;
 * that alone doesn't distinguish it from source).
 *
 * Reuses whatever specifier the CURRENT `package.json` already has for that name
 * - `file:`, `link:`, an exact version, a range, whatever `pnpm add` was given -
 * rather than computing one: overwriting a caller's `file:`/`link:` install with
 * a version range would silently re-point it at the registry (and that name may
 * not even resolve to the same package there). Only a package.json with no
 * existing entry at all (e.g. a first synth run by hand outside `bootstrapWorkspace`)
 * falls back to a real `^<version>` pin.
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
    workspaceEnvPaths = DEFAULT_WORKSPACE_ENV_PATHS,
    workspaceEnvs = WORKSPACE_ENVS,
    disableWorkspaceEnvs = [],
    catalog = DEFAULT_CATALOG,
    workspace,
    pnpmWorkspace,
  } = options;

  // Resolve the project name up front (git remote -> folder name), so it's
  // always a real string by the time the project is constructed - no readonly
  // `project.name` workaround needed. Also the npm scope for generated names.
  const name = explicitName ?? npmNameOf(projectName());

  const project = new javascript.NodeProject({
    ...ENGINE_DEFAULTS,
    ...extendsOptions,
    name,
  });

  const effectiveEnvs: Record<string, WorkspaceEnvDef> = { ...workspaceEnvs };
  for (const e of disableWorkspaceEnvs) delete effectiveEnvs[e];

  // Discover env packages by scanning the filesystem once (synth-time). The
  // member list, the subprojects, and the barrels all derive from this; every
  // other command reads the recorded list back from pnpm-workspace.yaml.
  const discovered = discoverPackages(resolve(project.outdir), workspaceEnvPaths);

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
  // point it at the single CLI watch orchestrator. `pnpm dbxtools` runs the
  // matching package script in-tree, else the linked `dbxtools` bin for a consumer
  // - either way one chokidar process handles config re-synth + barrels + new
  // packages, with no hand-rolled watcher wired through shell tasks.
  const watch = project.tasks.tryFind("watch") ?? project.addTask("watch");
  watch.reset("pnpm dbxtools sync --watch");

  // Root config files (all projen-owned: read-only + generated marker). The pnpm
  // workspace `packages` list is sourced from `project.subprojects` at synth (see
  // files.pnpmWorkspace) - so both these discovered packages AND any manual
  // `applyEnv` packages land there with no hardcoded member list.
  files.pnpmWorkspace(project, { catalog, modify: pnpmWorkspace });
  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.prettierConfig(project);
  files.prettierIgnore(project);
  files.vscodeTasks(project); // folderOpen -> `projen watch` -> `dbxtools sync --watch`
  files.vscodeSettings(project);
  files.vscodeExtensions(project);

  // Each discovered folder becomes a real projen TypeScriptProject subproject via
  // the same `applyEnv` primitive a caller uses manually - projen then owns its
  // package.json/tsconfig/tasks, and it is sourced into pnpm-workspace.yaml.
  for (const p of discovered) {
    const packageName = npmNameOf(name, p.envPath);
    applyEnv(project, {
      outdir: p.memberPath,
      name: packageName,
      env: workspaceEnvConfig(p.env, effectiveEnvs),
      spec: { env: p.env, name: p.name, packageName },
      workspace,
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
  for (const root of workspaceEnvPaths) {
    project.annotateGenerated(`/${root}/*/*/index.ts`);
    project.annotateGenerated(`/${root}/openapi/**`);
  }

  return project;
}
