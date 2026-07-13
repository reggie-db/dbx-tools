/**
 * `applyTags` - the reusable primitive that turns any repo path into a projen
 * `TypeScriptProject` subproject configured by one or more {@link TagDef}s.
 *
 * Auto-discovery (`configureProject`) calls it once per discovered package; a
 * `.projenrc.ts` can also call it directly to configure a package WITHOUT
 * auto-discovery. Either way the result is a real projen subproject, so projen
 * OWNS its `package.json`, `tsconfig.json`, and tasks - and, because it is a
 * subproject, it is sourced into `pnpm-workspace.yaml` from `project.subprojects`
 * (see `files.pnpmWorkspace`) with no manual member list.
 *
 * A package may match MULTIPLE tags (see `workspace.ts` tag candidates); their
 * {@link TagDef}s are merged in order (deps concatenated, tsconfig/tasks
 * later-wins) before being spread into the subproject. The resolved (deduped) tag
 * list is written to the package's `package.json` under `dbxToolsConfig.tags` (the
 * per-package source of truth) and recorded on the project, so the
 * `workspacePackage` hook - which runs LAST - reads it back with
 * {@link workspacePackageTagsOf}. The hook tweaks the REAL subproject with projen's
 * own API (`pkg.addDeps(...)`, `pkg.addTask(...)`, `pkg.package.addBin({...})`)
 * rather than mutating a serialized object.
 */
import { type Project, type TaskOptions, TextFile, javascript, typescript } from "projen";
import type { TagDef, WorkspaceTag } from "./tags";
import { type OneOrMany, toArray } from "./workspace";

/**
 * Last-chance per-workspace-package hook. `pkg` (the workspace package) is the real
 * projen subproject and the only argument - the mutation target AND the identity to
 * switch on. Edits go through projen's own API and stay projen-owned. Dispatch on
 * the stable folder via `workspacePackageTagsOf(pkg)` (the resolved tags) and
 * `basename(pkg.outdir)` (the folder name) rather than the derived `pkg.name`.
 */
export type WorkspacePackageModifier = (pkg: typescript.TypeScriptProject) => void;

/**
 * Built-in per-tag `workspacePackage` modifiers ("default workspace tag
 * modifiers"). `configureProject` runs the enabled subset (see its
 * `workspacePackageDefaults` option) on every package carrying the tag, AFTER the
 * tag config is applied and BEFORE the caller's `workspacePackage` hook. The keys
 * are the selectable defaults; extend this registry to add more.
 */
export const DEFAULT_WORKSPACE_PACKAGE_MODIFIERS = {
  /** A `server` package: an Express app run/watched with tsx (AppKit-aligned). */
  server: (pkg) => {
    pkg.addDeps("express@catalog:");
    pkg.addDevDeps("@types/express@catalog:");
    pkg.addTask("dev", { exec: "tsx watch src/server.ts" });
    pkg.addTask("start", { exec: "tsx src/server.ts" });
  },
} satisfies Partial<Record<WorkspaceTag, WorkspacePackageModifier>>;

/** A selectable default tag - a key of {@link DEFAULT_WORKSPACE_PACKAGE_MODIFIERS}. */
export type DefaultWorkspacePackageTag = keyof typeof DEFAULT_WORKSPACE_PACKAGE_MODIFIERS;

export interface ApplyTagsOptions {
  /** Repo-relative posix path for the package, e.g. `workspaces/ui/app`. */
  readonly outdir: string;
  /** The npm package name, e.g. `@dbx-tools/ui-app`. */
  readonly name: string;
  /** The tag config(s) to apply, merged in order (tsconfig overlay + deps/tasks). */
  readonly config: OneOrMany<TagDef>;
  /** The resolved tags to record in `package.json` (`dbxToolsConfig.tags`) + on the project. */
  readonly tags?: string[];
  /** Built-in default tag modifiers to run before `workspacePackage` (in order). */
  readonly defaultModifiers?: WorkspacePackageModifier[];
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

/** Tags applyTags recorded per project, so more can be unioned in later. */
const RECORDED_TAGS = new WeakMap<Project, string[]>();

/** The (deduped) tags recorded on a project so far (empty if none). */
export function workspacePackageTagsOf(project: Project): string[] {
  return RECORDED_TAGS.get(project) ?? [];
}

/**
 * Union `tags` into a project's recorded `dbxToolsConfig.tags`. Used when a
 * `workspacePackageRoots` root encapsulates an ALREADY-attached project (we don't
 * re-create it, just add its path-derived tags) and to give the ROOT project tags.
 * Returns the merged (deduped) list.
 */
export function addWorkspacePackageTags(
  project: javascript.NodeProject,
  tags: string[],
): string[] {
  const merged = [...new Set([...(RECORDED_TAGS.get(project) ?? []), ...tags])];
  RECORDED_TAGS.set(project, merged);
  project.package.addField("dbxToolsConfig", { tags: merged });
  return merged;
}

/** Tag-def keys handled specially by {@link mergeTagDefs}; the rest pass through. */
type TagDefExtras = {
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
 * Merge multiple {@link TagDef}s into one, in order. Dependency arrays
 * (`deps`/`devDeps`/`peerDeps`/`bundledDeps`) and `tsconfig.include` concatenate
 * (deduped); `tsconfig.compilerOptions` and `tasks` shallow-merge (later wins); a
 * `viteConfig` anywhere wins; every other projen option is later-wins. A single
 * def passes through essentially unchanged.
 */
function mergeTagDefs(defs: TagDef[]): TagDef {
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
      def as TagDef & TagDefExtras;
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
  return merged as TagDef;
}

/**
 * Apply a tag's `tasks` (name -> projen `TaskOptions`) through projen's task
 * system. projen's standard `build` task is locked, and its actual output step is
 * `compile`, so a tag's `build` is applied to `compileTask` (e.g. a Vite app
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
 * Compiler options every package needs regardless of tag. The whole repo is
 * `type: module` (ESM) and the sources use `import.meta`, so we override projen's
 * `module: "CommonJS"` default. `moduleResolution: BUNDLER` honors the `exports`
 * map, so a bare `@scope/pkg` import resolves to the package-root `index.ts`
 * barrel with no build step. Tag options layer on top, so a tag can still
 * override any of these.
 */
const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  // Don't type-check third-party `.d.ts` (e.g. openapi-typescript's transitive
  // @redocly/js-yaml types); a package's own code is still fully checked.
  skipLibCheck: true,
};

/**
 * Create the projen `TypeScriptProject` subproject for `options.outdir`, configured
 * by the merged `options.config`, and return it. The merged tag config's projen
 * options are spread straight in (deps + the `tsconfig` overlay, where
 * `lib`/`jsx`/`types` enforcement lives); projen supplies module/outDir/rootDir/
 * strictness from its own defaults. Structural fields (`parent`/`outdir`/`name`)
 * are set last so a tag can never override them.
 */
export function applyTags(
  parent: javascript.NodeProject,
  options: ApplyTagsOptions,
): typescript.TypeScriptProject {
  // Merge the one-or-many tag defs, then peel the two engine extras (and tsconfig,
  // which we merge below) off; the rest spreads straight into TypeScriptProject.
  const merged = mergeTagDefs(toArray(options.config));
  const { tasks, viteConfig, tsconfig, ...tagOptions } = merged as TagDef & TagDefExtras;

  // jsx tags (React) keep components in `.tsx`; add that glob to projen's default
  // `src/**/*.ts` include (projen concatenates, it doesn't replace).
  const include = [
    ...(tsconfig?.include ?? []),
    ...(tsconfig?.compilerOptions?.jsx ? ["src/**/*.tsx"] : []),
  ];

  const pkg = new typescript.TypeScriptProject({
    ...SUBPROJECT_DEFAULTS,
    ...tagOptions,
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

  // Vite-built tags get a minimal, projen-owned `vite.config.ts`.
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
  // commands - and record it on the project for the hook (workspacePackageTagsOf).
  const tags = [...new Set(options.tags ?? [])];
  RECORDED_TAGS.set(pkg, tags);
  pkg.package.addField("dbxToolsConfig", { tags });

  // Built-in default tag modifiers run after the tag config; the caller's
  // workspacePackage hook runs LAST. Both act on the real subproject only.
  for (const modify of options.defaultModifiers ?? []) modify(pkg);
  options.workspacePackage?.(pkg);

  // Lock the manifest last: projen leaves package.json writable, but here it is
  // fully projen-owned, so it joins the rest of the read-only generated tree.
  lockPackageJson(pkg);
  return pkg;
}
