/**
 * Shared package helpers the project classes (`./project`) and tag mixins
 * (`./tags`) build on:
 *   - {@link npmNameOf} - scope-based npm naming from ordered path parts;
 *   - {@link lockPackageJson} - force a project's `package.json` read-only;
 *   - {@link addWorkspacePackageTags} / {@link workspacePackageTagsOf} - a tag
 *     registry for NON-DBXTools projects a root encapsulates (a DBXTools project
 *     owns its own tags on its `dbxToolsConfig` component);
 *   - {@link applyTasks} - apply a tag's `tasks` through projen's task system;
 *   - {@link applyCompilerOptions} - override a package's generated tsconfig
 *     `compilerOptions` (how a tag mixin enforces `lib`/`jsx`/`types`);
 *   - {@link emitViteConfig} - emit a package's read-only `vite.config.ts`;
 *   - {@link SUBPROJECT_DEFAULTS} / {@link SHARED_COMPILER_OPTIONS} - the baseline
 *     projen options + ESM compiler options every package shares.
 *
 * A package may carry MULTIPLE tags; each tag's mixin (see `./tags`) is applied
 * across the workspace subtree in turn, so their deps and tsconfig overrides layer
 * (later-wins per key) - no explicit merge step. The resolved (deduped) tag list is
 * written to the package's `package.json` under `dbxToolsConfig.tags` - the
 * per-package source of truth read back by the post-synth commands.
 */
import { type Project, type TaskOptions, TextFile, javascript, typescript } from "projen";

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

/** Tags recorded per NON-DBXTools project, so more can be unioned in later. */
const RECORDED_TAGS = new WeakMap<Project, string[]>();

/** The (deduped) tags recorded on a non-DBXTools project so far (empty if none). */
export function workspacePackageTagsOf(project: Project): string[] {
  return RECORDED_TAGS.get(project) ?? [];
}

/**
 * Union `tags` into a NON-DBXTools project's recorded `dbxToolsConfig.tags`. Used
 * when a `workspacePackageRoots` root encapsulates an already-attached project that
 * is a plain projen project (a DBXTools project owns its own tags via `appendTag`).
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

/**
 * Override a package's generated tsconfig `compilerOptions` (later-wins per key).
 * This is how a tag mixin enforces a target environment after construction: a
 * `lib`/`types`/`jsx` override lands in the package's `tsconfig.json`, so
 * `document` in a `shared`/`server` package fails `tsc` (no DOM lib) and
 * `process`/`node:*` in a `ui` package fails (no node types). A `jsx` setting also
 * adds the package's `.tsx` sources to the compile so React components type-check.
 */
export function applyCompilerOptions(
  pkg: typescript.TypeScriptProject,
  compilerOptions: javascript.TypeScriptCompilerOptions,
): void {
  const file = pkg.tsconfig?.file;
  if (!file) return;
  for (const [key, value] of Object.entries(compilerOptions)) {
    if (value === undefined) continue;
    file.addOverride(`compilerOptions.${key}`, value);
  }
  if (compilerOptions.jsx) pkg.tsconfig?.addInclude("src/**/*.tsx");
}

/**
 * Emit a projen-owned, read-only `vite.config.ts` (React plugin) for a package.
 * Idempotent: a package that already has one (e.g. from the `viteConfig` option
 * and the `ui` tag mixin both firing) is left untouched.
 */
export function emitViteConfig(pkg: typescript.TypeScriptProject): void {
  if (pkg.tryFindFile("vite.config.ts")) return;
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

/**
 * Apply a tag's `tasks` (name -> projen `TaskOptions`) through projen's task
 * system. projen's standard `build` task is locked, and its actual output step is
 * `compile`, so a tag's `build` is applied to `compileTask` (e.g. a Vite app
 * compiles with `vite build`). Any other name resets an existing task if projen
 * already owns it, otherwise it is added as a new task.
 */
export function applyTasks(
  pkg: typescript.TypeScriptProject,
  tasks?: Record<string, TaskOptions>,
): void {
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
export const SUBPROJECT_DEFAULTS: Partial<typescript.TypeScriptProjectOptions> = {
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
  // subproject sets `packageManager` explicitly).
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
export const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  // Don't type-check third-party `.d.ts` (e.g. openapi-typescript's transitive
  // @redocly/js-yaml types); a package's own code is still fully checked.
  skipLibCheck: true,
};
