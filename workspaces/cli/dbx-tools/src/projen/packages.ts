/**
 * `applyEnv` - the reusable primitive that turns any repo path into a projen
 * `TypeScriptProject` subproject configured by one or more {@link EnvDef}s.
 *
 * Auto-discovery (`configureProjen`) calls it once per discovered package; a
 * `.projenrc.ts` can also call it directly to configure a package WITHOUT
 * auto-discovery. Either way the result is a real projen subproject, so projen
 * OWNS its `package.json`, `tsconfig.json`, and tasks - and, because it is a
 * subproject, it is sourced into `pnpm-workspace.yaml` from `project.subprojects`
 * (see `files.pnpmWorkspace`) with no manual member list.
 *
 * A package may match MULTIPLE envs (see `workspace.ts` env candidates); their
 * {@link EnvDef}s are merged in order (deps concatenated, tsconfig/tasks
 * later-wins) before being spread into the subproject. The resolved (deduped) tag
 * list is written to the package's `package.json` under `dbxToolsConfig.tags` (the
 * per-package source of truth) and handed to the `workspacePackage` hook via
 * `spec.tags`, which runs LAST so a caller tweaks the REAL subproject with
 * projen's own API (`pkg.addDeps(...)`, `pkg.addTask(...)`, `pkg.package.addBin({...})`)
 * rather than mutating a serialized object.
 */
import { type Project, type TaskOptions, TextFile, javascript, typescript } from "projen";
import type { EnvDef } from "./envs";
import { type OneOrMany, toArray, toPosix } from "./workspace";

/**
 * Read-only identity of a workspace package, passed to a
 * {@link WorkspacePackageModifier} so callers dispatch on the STABLE folder
 * (`tags`/`name`, e.g. tags including `cli` and name `main`) rather than the
 * derived `packageName`, which depends on the root npm scope.
 */
export interface WorkspacePackageSpec {
  /** The resolved, deduped tag list (the package's applied env names; may be empty). */
  readonly tags: string[];
  /** The package folder name (last path segment), e.g. `app`. */
  readonly name: string;
  /** The derived npm name, e.g. `@dbx-tools/cli-main`. */
  readonly packageName: string;
}

/**
 * Last-chance per-workspace-package hook. `pkg` (the workspace package) is the
 * real projen subproject and the only mutation target - edits go through projen's
 * own API and stay projen-owned. `spec` is the stable identity to switch on.
 */
export type WorkspacePackageModifier = (
  pkg: typescript.TypeScriptProject,
  spec: WorkspacePackageSpec,
) => void;

export interface ApplyEnvOptions {
  /** Repo-relative posix path for the package, e.g. `workspaces/ui/app`. */
  readonly outdir: string;
  /** The npm package name, e.g. `@dbx-tools/ui-app`. */
  readonly name: string;
  /** The env config(s) to apply, merged in order (tsconfig overlay + deps/tasks). */
  readonly env: OneOrMany<EnvDef>;
  /** The resolved tags to record in `package.json` (`dbxToolsConfig.tags`) + `spec.tags`. */
  readonly tags?: string[];
  /** Identity handed to `workspacePackage`; derived from `outdir`/`name` when omitted. */
  readonly spec?: WorkspacePackageSpec;
  /** Per-workspace-package tweak hook, run last. */
  readonly workspacePackage?: WorkspacePackageModifier;
}

/**
 * Build an npm package name from ordered parts. Each part is lowercased and split
 * on `/` and any run of non-`[a-z0-9._-]` chars; the cleaned segments join into an
 * npm name - a single segment stays bare (e.g. `dbx-tools`), while multiple become
 * `@<first>/<rest joined by ->`. So the first part is the npm scope:
 * `npmNameOf("dbx-tools", "cli", "main")` and `npmNameOf("dbx-tools", "cli/main")`
 * both give `@dbx-tools/cli-main`.
 */
export function npmNameOf(name: string, ...names: string[]): string {
  const nameParts = [name, ...names]
    .flatMap((part) => part.split("/"))
    .flatMap((part) =>
      part
        .toLowerCase()
        .split(/[^a-z0-9._-]+/)
        .map((seg) => seg.replace(/^[._-]+|[._-]+$/g, "")),
    )
    .filter(Boolean);
  if (!nameParts.length) throw new Error(`Invalid name: ${[name, ...names].join(", ")}`);
  if (nameParts.length === 1) return nameParts[0]!;
  return `@${nameParts[0]}/${nameParts.slice(1).join("-")}`;
}

/**
 * Force `project`'s `package.json` read-only. Alone among the files projen owns,
 * it writes `package.json` read-WRITE so package managers can mutate it; here
 * every dependency and field is projen-owned via `.projenrc.ts`, so we align it
 * with the rest of the generated tree. projen still rewrites it on every synth (it
 * clears the read-only bit, writes, then restores it), so this never blocks
 * re-synth. Works for the root project and any subproject. No-op if none exists.
 */
export function lockPackageJson(project: Project): void {
  const manifest = project.tryFindObjectFile("package.json");
  if (manifest) manifest.readonly = true;
}

/** Env-def keys handled specially by {@link mergeEnvDefs}; the rest pass through. */
type EnvDefExtras = {
  deps?: string[];
  devDeps?: string[];
  peerDeps?: string[];
  bundledDeps?: string[];
  tasks?: Record<string, TaskOptions>;
  viteConfig?: boolean;
  tsconfig?: {
    include?: string[];
    compilerOptions?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

/**
 * Merge multiple {@link EnvDef}s into one, in order. Dependency arrays
 * (`deps`/`devDeps`/`peerDeps`/`bundledDeps`) and `tsconfig.include` concatenate
 * (deduped); `tsconfig.compilerOptions` and `tasks` shallow-merge (later wins); a
 * `viteConfig` anywhere wins; every other projen option is later-wins. A single
 * def passes through essentially unchanged.
 */
function mergeEnvDefs(defs: EnvDef[]): EnvDef {
  const rest: Record<string, unknown> = {};
  const deps = new Set<string>();
  const devDeps = new Set<string>();
  const peerDeps = new Set<string>();
  const bundledDeps = new Set<string>();
  let tasks: Record<string, TaskOptions> = {};
  let viteConfig = false;
  let compilerOptions: Record<string, unknown> = {};
  const include = new Set<string>();
  let tsconfigRest: Record<string, unknown> = {};

  for (const def of defs) {
    const { deps: d, devDeps: dd, peerDeps: pd, bundledDeps: bd, tasks: t, viteConfig: v, tsconfig, ...other } =
      def as EnvDef & EnvDefExtras;
    for (const x of d ?? []) deps.add(x);
    for (const x of dd ?? []) devDeps.add(x);
    for (const x of pd ?? []) peerDeps.add(x);
    for (const x of bd ?? []) bundledDeps.add(x);
    if (t) tasks = { ...tasks, ...t };
    if (v) viteConfig = true;
    if (tsconfig) {
      const { include: inc, compilerOptions: co, ...tr } = tsconfig;
      for (const x of inc ?? []) include.add(x);
      if (co) compilerOptions = { ...compilerOptions, ...co };
      tsconfigRest = { ...tsconfigRest, ...tr };
    }
    Object.assign(rest, other);
  }

  const merged: Record<string, unknown> = { ...rest };
  if (deps.size) merged.deps = [...deps];
  if (devDeps.size) merged.devDeps = [...devDeps];
  if (peerDeps.size) merged.peerDeps = [...peerDeps];
  if (bundledDeps.size) merged.bundledDeps = [...bundledDeps];
  if (Object.keys(tasks).length) merged.tasks = tasks;
  if (viteConfig) merged.viteConfig = true;
  const tsconfig: Record<string, unknown> = { ...tsconfigRest };
  if (Object.keys(compilerOptions).length) tsconfig.compilerOptions = compilerOptions;
  if (include.size) tsconfig.include = [...include];
  if (Object.keys(tsconfig).length) merged.tsconfig = tsconfig;
  return merged as EnvDef;
}

/**
 * Apply an env's `tasks` (name -> projen `TaskOptions`) through projen's task
 * system. projen's standard `build` task is locked, and its actual output step is
 * `compile`, so an env's `build` is applied to `compileTask` (e.g. a Vite app
 * compiles with `vite build`). Any other name resets an existing task if projen
 * already owns it, otherwise it is added as a new task.
 */
function applyTasks(pkg: typescript.TypeScriptProject, tasks?: Record<string, TaskOptions>): void {
  if (!tasks) return;
  for (const [name, options] of Object.entries(tasks)) {
    const owned = name === "build" ? pkg.compileTask : pkg.tasks.tryFind(name);
    if (owned) owned.reset(options.exec, options);
    else pkg.addTask(name, options);
  }
}

/**
 * Baseline options every subproject shares. They mirror the ROOT project's own
 * choices (no jest/eslint/prettier/github/release/upgrade) so the generated
 * workspace stays lean and consistent. `sampleCode: false` stops projen from
 * dropping template `src/` files over the developer's own sources.
 */
const SUBPROJECT_DEFAULTS: Partial<typescript.TypeScriptProjectOptions> = {
  defaultReleaseBranch: "main",
  sampleCode: false,
  jest: false,
  eslint: false,
  prettier: false,
  github: false,
  buildWorkflow: false,
  release: false,
  npmignoreEnabled: false,
  licensed: false,
  depsUpgrade: false,
  // pnpm 11 errors "Cannot use both packageManager and devEngines.packageManager"
  // - projen would otherwise auto-add the latter alongside the former (every
  // subproject sets `packageManager` explicitly below).
  addPackageManagerToDevEngines: false,
};

/**
 * Compiler options every package needs regardless of env. The whole repo is
 * `type: module` (ESM) and the sources use `import.meta`, so we override projen's
 * `module: "CommonJS"` default. `moduleResolution: BUNDLER` honors the `exports`
 * map, so a bare `@scope/pkg` import resolves to the package-root `index.ts`
 * barrel with no build step. Env options layer on top, so an env can still
 * override any of these.
 */
const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  // Don't type-check third-party `.d.ts` (e.g. openapi-typescript's transitive
  // @redocly/js-yaml types); a package's own code is still fully checked.
  skipLibCheck: true,
};

/** Derive a {@link WorkspacePackageSpec} from a member path when the caller didn't pass one. */
function specFromOutdir(outdir: string, packageName: string, tags: string[]): WorkspacePackageSpec {
  const segs = toPosix(outdir).split("/").filter(Boolean);
  return { tags, name: segs[segs.length - 1] ?? outdir, packageName };
}

/**
 * Create the projen `TypeScriptProject` subproject for `options.outdir`, configured
 * by the merged `options.env`, and return it. The merged env's projen options are
 * spread straight in (deps + the `tsconfig` overlay, where `lib`/`jsx`/`types`
 * enforcement lives); projen supplies module/outDir/rootDir/strictness from its own
 * defaults. Structural fields (`parent`/`outdir`/`name`) are set last so an env can
 * never override them.
 */
export function applyEnv(
  parent: javascript.NodeProject,
  options: ApplyEnvOptions,
): typescript.TypeScriptProject {
  // Merge the one-or-many env defs, then peel the two engine extras (and tsconfig,
  // which we merge below) off; the rest spreads straight into TypeScriptProject.
  const merged = mergeEnvDefs(toArray(options.env));
  const { tasks, viteConfig, tsconfig, ...envOptions } = merged as EnvDef & EnvDefExtras;

  // jsx envs (React) keep components in `.tsx`; add that glob to projen's default
  // `src/**/*.ts` include (projen concatenates, it doesn't replace).
  const include = [
    ...(tsconfig?.include ?? []),
    ...(tsconfig?.compilerOptions?.jsx ? ["src/**/*.tsx"] : []),
  ];

  const pkg = new typescript.TypeScriptProject({
    ...SUBPROJECT_DEFAULTS,
    ...envOptions,
    parent,
    outdir: options.outdir,
    name: options.name,
    packageManager: parent.package.packageManager,
    tsconfig: {
      ...tsconfig,
      include: include.length ? include : undefined,
      compilerOptions: { ...SHARED_COMPILER_OPTIONS, ...tsconfig?.compilerOptions },
    },
  });

  // Source-first entry: point the package at the package-ROOT `index.ts` barrel
  // (above `src/`, written by the barrels step) so workspace packages resolve each
  // other's `@scope/pkg` imports straight to source with no build. `type: module`
  // keeps the subproject ESM like the root.
  pkg.package.addField("type", "module");
  pkg.package.addField("main", "index.ts");
  pkg.package.addField("types", "index.ts");
  pkg.package.addField("exports", {
    ".": "./index.ts",
    "./package.json": "./package.json",
  });

  applyTasks(pkg, tasks);

  // Vite-built envs get a minimal, projen-owned `vite.config.ts`.
  if (viteConfig) {
    new TextFile(pkg, "vite.config.ts", {
      marker: true,
      readonly: true,
      lines: [
        'import react from "@vitejs/plugin-react";',
        'import { defineConfig } from "vite";',
        "",
        "export default defineConfig({ plugins: [react()] });",
        "",
      ],
    });
  }

  // Persist the resolved (deduped) tag list in the package's package.json under
  // `dbxToolsConfig.tags` - the per-package source of truth, readable by post-synth
  // commands - and expose it to the hook via `spec.tags`; the hook runs LAST.
  const tags = [...new Set(options.tags ?? options.spec?.tags ?? [])];
  pkg.package.addField("dbxToolsConfig", { tags });
  options.workspacePackage?.(pkg, options.spec ?? specFromOutdir(options.outdir, options.name, tags));

  // Lock the manifest last: projen leaves package.json writable, but here it is
  // fully projen-owned, so it joins the rest of the read-only generated tree.
  lockPackageJson(pkg);
  return pkg;
}
