/**
 * The compiled publish surface: what a package looks like on npm, as opposed to
 * what it looks like inside this workspace.
 *
 * Packages resolve each other from SOURCE - every `exports` entry points at a
 * `.ts` file, so a cross-package import type-checks with no build step and no
 * `dist` to keep in sync. That property is worth keeping, but it cannot be what
 * ships: Node refuses to strip types under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a published package whose
 * entry point is `index.ts` is unloadable by anything that is not a bundler.
 * Consumers papered over that by special-casing `@dbx-tools/*` into their own
 * bundle, which is a tax this repo has no business charging.
 *
 * pnpm resolves both at once. It substitutes `publishConfig`'s `main`/`types`/
 * `exports` into the manifest at pack time and drops `publishConfig` itself, so
 * the workspace keeps its source entry points while the tarball advertises the
 * compiled ones. Nothing here changes how the repo builds or type-checks; it
 * only changes what `pnpm pack` writes.
 *
 * Two pieces make the emitted tree actually loadable:
 *
 * - `rootDir: "."` so the package-ROOT `index.ts` barrel is compiled at all.
 *   projen's default `rootDir: "src"` puts the barrel outside the compilation,
 *   which is why `lib/` has never had an `index.js`.
 * - a specifier pass after `tsc`, because `tsc` never rewrites import paths.
 *   Sources are written for `moduleResolution: bundler` and so import `"./http"`,
 *   which Node cannot resolve; `tasks/emit.ts` appends the extension that the
 *   emitted file actually has. Doing it after the fact keeps 800-odd import
 *   sites free of the `.js` suffix that would otherwise have to be written - and
 *   maintained - by hand.
 *
 * UI packages are deliberately excluded (see {@link publishesCompiled}).
 */
import type { javascript } from "projen";
import { typescript } from "projen";
import { addPackageFiles, applyCompilerOptions, applyIncludes, taskScript } from "./project";
import { isDBXToolsProject } from "./project-predicate";

/** Directory `tsc` emits into, and the root of every published entry point. */
export const COMPILED_DIR = "lib";

/** An `exports` target written as TypeScript source, i.e. one with a compiled twin. */
const TS_SOURCE = /\.tsx?$/;

/**
 * Whether a package publishes compiled output rather than source.
 *
 * Everything does EXCEPT the `ui` tag, and the exclusion is about consumers
 * rather than convenience. The problem being solved is that Node cannot load raw
 * TypeScript - but a browser package is never loaded by Node. UI packages reach
 * their consumer through Vite, which reads their source happily, and they export
 * `./styles.css` plus raw SVG assets that `tsc` does not copy and could not
 * rewrite. Compiling them would mean a real asset pipeline (Vite library mode)
 * to solve a problem they do not have.
 *
 * This is the same split the downstream app build already makes on its own: its
 * client bundle resolves `@dbx-tools/ui-*` from source without complaint, while
 * its SERVER bundle is the one that had to inline `@dbx-tools/*` to avoid
 * handing Node a `.ts` entry point.
 */
export function publishesCompiled(pkg: javascript.NodeProject): boolean {
  if (!(pkg instanceof typescript.TypeScriptProject) || !pkg.parent) return false;
  return isDBXToolsProject(pkg) && !pkg.dbxToolsConfig.tags.includes("ui");
}

/**
 * The compiled counterpart of a source `exports` target, or `undefined` for a
 * target that ships as-is (`./package.json`, a stylesheet, an SVG asset).
 *
 * `rootDir: "."` means the emitted tree mirrors the package layout, so the
 * mapping is positional: `./src/react/index.ts` -> `./lib/src/react/index.js`.
 */
function compiledTarget(target: string): { types: string; default: string } | undefined {
  if (!TS_SOURCE.test(target)) return undefined;
  const stem = `./${COMPILED_DIR}/${target.replace(/^\.\//, "").replace(TS_SOURCE, "")}`;
  return { types: `${stem}.d.ts`, default: `${stem}.js` };
}

/**
 * Derive `publishConfig` from the package's FINAL `exports` map.
 *
 * Runs at preSynthesize precisely so the tags have already installed their
 * export layouts - deriving it any earlier would mirror the constructor's bare
 * `.` entry and silently omit every subpath a tag added.
 */
function publishConfig(pkg: javascript.NodeProject): Record<string, unknown> | undefined {
  const exports = (pkg.package.manifest.exports ?? {}) as Record<string, string>;
  const compiled = Object.entries(exports).map(
    ([subpath, target]) => [subpath, compiledTarget(target) ?? target] as const,
  );
  // Nothing to swap means the package ships no TypeScript entry point at all;
  // leave its manifest alone rather than writing an inert `publishConfig`.
  if (!compiled.some(([, target]) => typeof target !== "string")) return undefined;

  // Setting this field REPLACES whatever projen renders into it, and what projen
  // renders is `access` - dropped, every scoped package here would publish as
  // restricted. It is not readable from `manifest` at preSynthesize (projen
  // emits it from `npmAccess` later), so carry it over from that source instead.
  const root = compiled.find(([subpath]) => subpath === ".")?.[1];
  return {
    access: pkg.package.npmAccess,
    ...(typeof root === "object" ? { main: root.default, types: root.types } : {}),
    exports: Object.fromEntries(compiled),
  };
}

/**
 * Give a package a compiled publish surface: emit the barrel, fix the emitted
 * specifiers, ship `lib/`, and advertise it through `publishConfig`.
 *
 * Idempotent - `preSynthesizeProject` reaches every package twice (once from the
 * root's walk, once from the package's own preSynthesize) and both passes must
 * agree.
 */
export function applyCompiledPublish(pkg: javascript.NodeProject): void {
  if (!publishesCompiled(pkg)) return;

  // The barrel lives at the package root, so the compilation has to start there.
  // The `cli` tag already does this for its `bin/` tree; for everything else it
  // is what puts an `index.js` in the emitted output for the first time.
  applyCompilerOptions(pkg, { rootDir: "." });
  applyIncludes(pkg, "index.ts");
  addPackageFiles(pkg, COMPILED_DIR);

  const config = publishConfig(pkg);
  if (config) pkg.package.addField("publishConfig", config);

  // `tsc` emits extensionless relative specifiers; Node ESM cannot resolve them.
  const fixSpecifiers = taskScript(pkg, "emit.ts", COMPILED_DIR);
  if (!pkg.compileTask.steps.some((step) => step.exec === fixSpecifiers)) {
    pkg.compileTask.exec(fixSpecifiers);
  }

  // The release workflow publishes straight after `pnpm install`, with no build
  // in between, so the compiled output has to be produced by the pack itself
  // rather than assumed present. This also covers a bare `pnpm pack` and the
  // bump task's local-registry publish.
  if (!pkg.tasks.tryFind("prepack")) {
    pkg.addTask("prepack", { description: "Compile before packing the published tarball" });
  }
  const prepack = pkg.tasks.tryFind("prepack")!;
  if (prepack.steps.length === 0) prepack.spawn(pkg.compileTask);
}
