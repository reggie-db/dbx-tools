/**
 * Turns one discovered workspace folder (`workspaces/<env>/<name>`) into a real
 * projen `TypeScriptProject` subproject (attached to the root via `parent`).
 * projen then OWNS that package's `package.json`, `tsconfig.json`, and tasks (its
 * generated marker) - there is no hand-rolled, read-only manifest generation.
 *
 * What stays package-specific is only:
 *  - the workspace-env config (see `./envs`), which drives the tsconfig
 *    `lib`/`jsx`/`types` overlay (the real env enforcement) plus baseline
 *    deps/tasks, and
 *  - the `modifyPackage` hook, which receives the REAL subproject, so a caller
 *    tweaks it with normal projen APIs (`pkg.addDeps("x@catalog:")`,
 *    `pkg.addTask(...)`, `pkg.package.addBin({...})`) rather than mutating a plain
 *    object we then serialize.
 */
import { type Project, type TaskOptions, TextFile, javascript, typescript } from "projen";
import { type WorkspaceEnvDef, workspaceEnvConfig } from "./envs";
import { DiscoveredPackage } from "./workspace";

/**
 * Read-only identity of a package, passed to {@link ModifyPackage} so callers
 * dispatch on the STABLE folder (`env`/`name`, e.g. `cli`/`main`) rather than the
 * derived `packageName`, which depends on the root npm scope.
 */
export interface PackageSpec {
  /** The workspace env (folder under the env root), e.g. `ui`. */
  readonly env: string;
  /** The package folder name, e.g. `app`. */
  readonly name: string;
  /** The derived npm name, e.g. `@dbx-tools/cli-main`. */
  readonly packageName: string;
}

/**
 * Last-chance per-package hook. `pkg` is the real projen subproject and the only
 * mutation target - edits go through projen's own API and stay projen-owned:
 * `pkg.addDeps("express@catalog:")`, `pkg.addTask("dev", { exec })`,
 * `pkg.package.addBin({ tool: "./src/cli.ts" })`, etc. `spec` is the stable folder
 * identity to switch on.
 */
export type ModifyPackage = (pkg: typescript.TypeScriptProject, spec: PackageSpec) => void;

export interface DefinePackageOptions {
  /** The root project every subproject attaches to (via projen `parent`). */
  readonly parent: javascript.NodeProject;
  /**
   * The npm scope for generated names (`@<npmScope>/<env>-<name>`). Passed in
   * explicitly because the root `project.name` is readonly and often left `""`
   * for the engine to backfill, so it can't be read back off the parent here.
   */
  readonly npmScope: string;
  readonly workspaceEnvs?: Record<string, WorkspaceEnvDef>;
  readonly modifyPackage?: ModifyPackage;
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
 * with the rest of the generated tree (tsconfig, pnpm-workspace, ...). projen
 * still rewrites it on every synth - it clears the read-only bit, writes, then
 * restores it - so this never blocks re-synth. Works for the root project and any
 * subproject alike. No-op if the project has no `package.json`.
 */
export function lockPackageJson(project: Project): void {
  const manifest = project.tryFindObjectFile("package.json");
  if (manifest) manifest.readonly = true;
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
 * Baseline options every example subproject shares. They mirror the ROOT
 * project's own choices (no jest/eslint/prettier/github/release/upgrade) so the
 * generated workspace stays lean and consistent. `sampleCode: false` stops projen
 * from dropping template `src/` files over the developer's own sources.
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
};

/**
 * Compiler options every package needs regardless of env. The whole repo is
 * `type: module` (ESM) and the sources use `import.meta`, so we override projen's
 * `module: "CommonJS"` default. `moduleResolution: BUNDLER` honors the `exports`
 * map, so a bare `@scope/pkg` import resolves to the package-root `index.ts`
 * barrel (see {@link definePackage}) with no build step. Env options layer on top,
 * so an env can still override any of these.
 */
const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
};

/**
 * Create the projen `TypeScriptProject` subproject for one discovered package and
 * return it. The env's projen options are spread straight in (deps + the
 * `tsconfig` overlay, where `lib`/`jsx`/`types` enforcement lives); projen
 * supplies module/outDir/rootDir/strictness from its own defaults. Structural
 * fields (`parent`/`outdir`/`name`) are set last so an env can never override them.
 */
export function definePackage(
  discoveredPackage: DiscoveredPackage,
  options: DefinePackageOptions,
): typescript.TypeScriptProject {
  // An env IS a projen options bag plus two engine extras; peel the extras (and
  // tsconfig, which we merge below) off, then spread the rest straight through.
  const { tasks, viteConfig, tsconfig, ...envOptions } = workspaceEnvConfig(
    discoveredPackage.env,
    options.workspaceEnvs,
  );

  // jsx envs (React) keep components in `.tsx`; add that glob to projen's default
  // `src/**/*.ts` include (projen concatenates, it doesn't replace).
  const include = [
    ...(tsconfig?.include ?? []),
    ...(tsconfig?.compilerOptions?.jsx ? ["src/**/*.tsx"] : []),
  ];

  const packageName = npmNameOf(options.npmScope, discoveredPackage.envPath);

  const pkg = new typescript.TypeScriptProject({
    ...SUBPROJECT_DEFAULTS,
    ...envOptions,
    parent: options.parent,
    outdir: discoveredPackage.memberPath,
    name: packageName,
    packageManager: options.parent.package.packageManager,
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

  options.modifyPackage?.(pkg, {
    env: discoveredPackage.env,
    name: discoveredPackage.name,
    packageName,
  });

  // Lock the manifest last: projen leaves package.json writable, but here it is
  // fully projen-owned, so it joins the rest of the read-only generated tree.
  lockPackageJson(pkg);
  return pkg;
}
