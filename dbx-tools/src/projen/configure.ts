/**
 * `configureProjen(project, options)` - taps into a projen `NodeProject` the
 * caller already created and turns it into an env-enforcing pnpm monorepo.
 *
 * Everything is auto-detected from folders: under each `workspaceEnvPaths` root,
 * any `<env>/<name>` folder with a `src/` becomes a projen `TypeScriptProject`
 * subproject configured from its env (see `./envs`). The discovered set is
 * written to `pnpm-workspace.yaml` (the SOURCE OF TRUTH) - every other command
 * reads it back rather than re-scanning. Per-package tweaks go in `modifyPackage`.
 * The engine itself lives outside the env layout, so it is never auto-configured -
 * consumers install it from npm as `dbx-tools` and add it via `additionalWorkspaces`.
 */
import { resolve } from "node:path";
import { Component, type javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import { WORKSPACE_ENVS, type WorkspaceEnv, type WorkspaceEnvDef } from "./envs";
import * as files from "./files";
import { type ModifyPackage, definePackage, lockPackageJson, npmNameOf } from "./packages";
import { DEFAULT_WORKSPACE_ENV_PATHS, discoverPackages, projectName } from "./workspace";

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
};

export interface ConfigureProjenOptions {
  /**
   * Workspace-env roots to scan for `<env>/<name>` packages. Each root's immediate
   * subfolders are env names; a `<env>/<name>` folder with a `src/` holding a
   * module file is a package. Defaults to {@link DEFAULT_WORKSPACE_ENV_PATHS}
   * (`["workspaces"]`).
   */
  readonly workspaceEnvPaths?: readonly string[];
  /**
   * Extra literal workspace members added to `pnpm-workspace.yaml` on top of the
   * discovered env packages - e.g. an in-tree copy of this engine. Their `src` is
   * watched for re-synth. Defaults to `[]`.
   */
  readonly additionalWorkspaces?: readonly string[];
  /** Env -> config map. Defaults to the built-in {@link WORKSPACE_ENVS}. */
  readonly workspaceEnvs?: Record<string, WorkspaceEnvDef>;
  /** Envs to turn off (their folders fall back to the default/agnostic config). */
  readonly disableWorkspaceEnvs?: WorkspaceEnv[];
  /** pnpm `catalog:` versions. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /** Per-package hook to tweak the generated subproject (deps, tasks, bin, ...). */
  readonly modifyPackage?: ModifyPackage;
  /** Hook to tweak the assembled `pnpm-workspace.yaml` object (members, catalog, ...). */
  readonly modifyPnpmWorkspace?: files.ModifyPnpmWorkspace;
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

/** Tap into a caller-created project. Returns it (caller runs `.synth()`). */
export function configureProjen(
  project: javascript.NodeProject,
  options: ConfigureProjenOptions = {},
): javascript.NodeProject {
  const {
    workspaceEnvPaths = DEFAULT_WORKSPACE_ENV_PATHS,
    additionalWorkspaces = [],
    workspaceEnvs = WORKSPACE_ENVS,
    disableWorkspaceEnvs = [],
    catalog = DEFAULT_CATALOG,
    modifyPackage,
    modifyPnpmWorkspace,
  } = options;

  // Resolve the project name: use the one the caller set, else backfill it from
  // the auto-detected repo identity (git remote -> folder), normalized via
  // npmNameOf. projen renders package.json `name` from the readonly project.name
  // (which stays "" when the caller omits it), so write the resolved value there.
  // That name is also the npm scope for generated package names (`@<name>/...`).
  let name = project.name;
  if (!name) {
    name = npmNameOf(projectName());
    project.package.addField("name", name);
  }

  const effectiveEnvs: Record<string, WorkspaceEnvDef> = { ...workspaceEnvs };
  for (const e of disableWorkspaceEnvs) delete effectiveEnvs[e];

  // Discover env packages by scanning the filesystem once (synth-time). The
  // member list, the subprojects, and the barrels all derive from this; every
  // other command reads the recorded list back from pnpm-workspace.yaml.
  const discovered = discoverPackages(resolve(project.outdir), workspaceEnvPaths);

  // Run `.projenrc.ts` through tsx.
  new typescript.ProjenrcTs(project, { runner: typescript.TypeScriptRunner.tsx() });

  // Root devDeps the toolchain needs. The `dbxtools` CLI ships with the
  // `dbx-tools` package the caller already depends on, so it is invoked by bin
  // name (`pnpm dbxtools`) rather than added here.
  project.addDevDeps("tsx@^4.23.0", "typescript@^5.9.3", "@types/node@^24.6.0");

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
  // workspace members are the discovered env packages plus any extra members.
  files.pnpmWorkspace(project, {
    packages: [...discovered.map((p) => p.memberPath), ...additionalWorkspaces],
    catalog,
    modify: modifyPnpmWorkspace,
  });
  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.prettierConfig(project);
  files.prettierIgnore(project);
  files.vscodeTasks(project); // folderOpen -> `projen watch` -> `dbxtools sync --watch`
  files.vscodeSettings(project);
  files.vscodeExtensions(project);

  // Each discovered folder becomes a real projen TypeScriptProject subproject
  // (projen then owns its package.json/tsconfig/tasks).
  for (const p of discovered) {
    definePackage(p, { parent: project, npmScope: name, workspaceEnvs: effectiveEnvs, modifyPackage });
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
