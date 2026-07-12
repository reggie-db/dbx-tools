/**
 * `configureProjen(project, options)` - taps into a projen `NodeProject` the
 * caller already created and turns it into an env-enforcing pnpm monorepo.
 *
 * Everything is auto-detected from folders: under each `workspaceEnvPaths` root,
 * any `<env>/<name>` folder with a `src/` becomes a projen `TypeScriptProject`
 * subproject (via the exported `applyEnv` primitive) configured from its env (see
 * `./envs`). `pnpm-workspace.yaml` (the SOURCE OF TRUTH every other command reads
 * back) sources its members from `project.subprojects`, so a package configured
 * MANUALLY with `applyEnv` - without auto-discovery - lands there too. Per-package
 * tweaks go in the `workspace` hook. The engine itself lives outside the env
 * layout and is configured manually (`applyEnv`) in `.projenrc.ts`.
 */
import { resolve } from "node:path";
import { Component, type javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import {
  WORKSPACE_ENVS,
  type WorkspaceEnv,
  type WorkspaceEnvDef,
  workspaceEnvConfig,
} from "./envs";
import * as files from "./files";
import { type WorkspaceModifier, applyEnv, lockPackageJson, npmNameOf } from "./packages";
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

/** Tap into a caller-created project. Returns it (caller runs `.synth()`). */
export function configureProjen(
  project: javascript.NodeProject,
  options: ConfigureProjenOptions = {},
): javascript.NodeProject {
  const {
    workspaceEnvPaths = DEFAULT_WORKSPACE_ENV_PATHS,
    workspaceEnvs = WORKSPACE_ENVS,
    disableWorkspaceEnvs = [],
    catalog = DEFAULT_CATALOG,
    workspace,
    pnpmWorkspace,
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
