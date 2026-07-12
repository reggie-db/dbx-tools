/**
 * `applyEnv` - the reusable primitive that turns any repo path into a projen
 * `TypeScriptProject` subproject configured by an {@link EnvDef}.
 *
 * Auto-discovery (`configureProjen`) calls it once per discovered
 * `workspaces/<env>/<name>` folder; a `.projenrc.ts` can also call it directly to
 * configure a package WITHOUT auto-discovery (e.g. the in-tree `dbx-tools` engine).
 * Either way the result is a real projen subproject, so projen OWNS its
 * `package.json`, `tsconfig.json`, and tasks - and, because it is a subproject, it
 * is sourced into `pnpm-workspace.yaml` from `project.subprojects` (see
 * `files.pnpmWorkspace`) with no manual member list.
 *
 * What stays package-specific is only the {@link EnvDef} (the tsconfig
 * `lib`/`jsx`/`types` overlay + baseline deps/tasks - the real env enforcement)
 * and the `workspace` hook, which receives the REAL subproject so a caller tweaks
 * it with projen's own API (`pkg.addDeps("x@catalog:")`, `pkg.addTask(...)`,
 * `pkg.package.addBin({...})`) rather than mutating a serialized object.
 */
import { type Project, type TaskOptions, TextFile, javascript, typescript } from "projen";
import type { EnvDef } from "./envs";
import { toPosix } from "./workspace";

/**
 * Read-only identity of a package, passed to a {@link WorkspaceModifier} so callers
 * dispatch on the STABLE folder (`env`/`name`, e.g. `cli`/`main`) rather than the
 * derived `packageName`, which depends on the root npm scope.
 */
export interface PackageSpec {
  /** The workspace env (folder under the env root), e.g. `ui`. `""` if unknown. */
  readonly env: string;
  /** The package folder name, e.g. `app`. */
  readonly name: string;
  /** The derived npm name, e.g. `@dbx-tools/cli-main`. */
  readonly packageName: string;
}

/**
 * Last-chance per-package hook. `pkg` (the workspace) is the real projen
 * subproject and the only mutation target - edits go through projen's own API and
 * stay projen-owned. `spec` is the stable folder identity to switch on.
 */
export type WorkspaceModifier = (pkg: typescript.TypeScriptProject, spec: PackageSpec) => void;

export interface ApplyEnvOptions {
  /** Repo-relative posix path for the package, e.g. `workspaces/ui/app` or `dbx-tools`. */
  readonly outdir: string;
  /** The npm package name, e.g. `@dbx-tools/ui-app`. */
  readonly name: string;
  /** The env config to apply (tsconfig overlay + baseline deps/tasks/viteConfig). */
  readonly env: EnvDef;
  /** Identity handed to `workspace`; derived from `outdir`/`name` when omitted. */
  readonly spec?: PackageSpec;
  /** Per-package tweak hook (the workspace). */
  readonly workspace?: WorkspaceModifier;
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

/** Derive a {@link PackageSpec} from a member path when the caller didn't pass one. */
function specFromOutdir(outdir: string, packageName: string): PackageSpec {
  const segs = toPosix(outdir).split("/").filter(Boolean);
  return {
    env: segs.length >= 2 ? segs[segs.length - 2]! : "",
    name: segs[segs.length - 1] ?? outdir,
    packageName,
  };
}

/**
 * Create the projen `TypeScriptProject` subproject for `options.outdir`, configured
 * by `options.env`, and return it. The env's projen options are spread straight in
 * (deps + the `tsconfig` overlay, where `lib`/`jsx`/`types` enforcement lives);
 * projen supplies module/outDir/rootDir/strictness from its own defaults. Structural
 * fields (`parent`/`outdir`/`name`) are set last so an env can never override them.
 */
export function applyEnv(
  parent: javascript.NodeProject,
  options: ApplyEnvOptions,
): typescript.TypeScriptProject {
  // An env IS a projen options bag plus two engine extras; peel the extras (and
  // tsconfig, which we merge below) off, then spread the rest straight through.
  const { tasks, viteConfig, tsconfig, ...envOptions } = options.env;

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

  options.workspace?.(pkg, options.spec ?? specFromOutdir(options.outdir, options.name));

  // Lock the manifest last: projen leaves package.json writable, but here it is
  // fully projen-owned, so it joins the rest of the read-only generated tree.
  lockPackageJson(pkg);
  return pkg;
}
