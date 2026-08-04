/**
 * The compiled publish surface: what a package looks like on npm, as opposed to
 * what it looks like inside this workspace.
 *
 * Packages resolve each other from SOURCE - every `exports` entry points at a
 * `.ts` file, so a cross-package import type-checks with no build step and no
 * `lib` to keep in sync. That property is worth keeping, but it cannot be what
 * ships: Node refuses to strip types under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a published package whose
 * entry point is `index.ts` is unloadable by anything that is not a bundler.
 *
 * pnpm resolves both at once. It substitutes `publishConfig`'s `main`/`types`/
 * `bin`/`exports` into the manifest at pack time and drops `publishConfig`
 * itself, so the workspace keeps its source entry points while the tarball
 * advertises the compiled ones. Nothing here changes how the repo builds or
 * type-checks; it only changes what `pnpm pack` writes.
 *
 * Two compiler options make the emitted tree loadable, both native `tsc`:
 *
 * - `rootDir: "."` so the package-ROOT `index.ts` barrel is compiled at all.
 *   projen's default `rootDir: "src"` puts the barrel outside the compilation,
 *   which is why `lib/` would otherwise have no `index.js`.
 * - `rewriteRelativeImportExtensions`, which turns the `./x.ts` specifiers this
 *   repo writes into the `./x.js` Node's ESM resolver needs. Sources carry the
 *   real extension (`allowImportingTsExtensions`) and `tsc` rewrites it on emit,
 *   so no post-processing pass is involved.
 *
 * UI packages are deliberately excluded (see {@link publishesCompiled}).
 */
import type { javascript } from "projen";
import { typescript } from "projen";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import { addPackageFiles, applyCompilerOptions, applyIncludes } from "./project.ts";

/** Directory `tsc` emits into, and the root of every published entry point. */
export const COMPILED_DIR = "lib";

/** An `exports`/`bin` target written as TypeScript source, i.e. with a compiled twin. */
const TS_SOURCE = /\.tsx?$/;

/**
 * Compiler options that make a package's emitted `lib/` tree loadable by Node.
 *
 * Only `rootDir` here: the specifier rewriting
 * (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`) is part of
 * the tsconfig floor EVERY package gets, since the `.ts`-suffixed specifier style
 * is a property of the source rather than of publishing.
 */
export const COMPILED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  rootDir: ".",
};

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
 */
export function publishesCompiled(pkg: javascript.NodeProject): boolean {
  if (!(pkg instanceof typescript.TypeScriptProject) || !pkg.parent) return false;
  return isDBXToolsJavaScriptProject()(pkg) && !pkg.dbxToolsConfig.tags.includes("ui");
}

/** The `./lib/...` stem of a source path, or `undefined` if it is not TypeScript. */
function compiledStem(target: string): string | undefined {
  if (!TS_SOURCE.test(target)) return undefined;
  return `./${COMPILED_DIR}/${target.replace(/^\.\//, "").replace(TS_SOURCE, "")}`;
}

/**
 * The compiled counterpart of a source `exports` target, or `undefined` for a
 * target that ships as-is (`./package.json`, a stylesheet, an SVG asset).
 *
 * `rootDir: "."` means the emitted tree mirrors the package layout, so the
 * mapping is positional: `./src/react/index.ts` -> `./lib/src/react/index.js`.
 */
function compiledTarget(target: string): { types: string; default: string } | undefined {
  const stem = compiledStem(target);
  return stem ? { types: `${stem}.d.ts`, default: `${stem}.js` } : undefined;
}

/**
 * Derive `publishConfig` from the package's FINAL `exports` + `bin` maps.
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

  // A CLI's `bin` points at its `.ts` entry in-repo (Node strips types outside
  // `node_modules`, so a workspace checkout runs it directly); the tarball has to
  // point at the emitted `.js`, which is what lets the published CLI run with no
  // loader installed.
  // `bin` is rendered LAZILY (projen assigns `bin: () => this.renderBin()` and
  // keeps the map itself private), so unlike `exports` this has to be called -
  // reading the field directly yields the function and finds no entries.
  const binField = pkg.package.manifest.bin as
    Record<string, string> | (() => Record<string, string>) | undefined;
  const bin = (typeof binField === "function" ? binField() : binField) ?? {};
  const compiledBin = Object.entries(bin).flatMap(([name, target]) => {
    const stem = compiledStem(target);
    return stem ? [[name, `${stem}.js`] as const] : [];
  });

  // Nothing to swap means the package ships no TypeScript entry point at all;
  // leave its manifest alone rather than writing an inert `publishConfig`.
  const swaps = compiled.some(([, target]) => typeof target !== "string");
  if (!swaps && compiledBin.length === 0) return undefined;

  // Setting this field REPLACES whatever projen renders into it, and what projen
  // renders is `access` - dropped, every scoped package here would publish as
  // restricted. It is not readable from `manifest` at preSynthesize (projen
  // emits it from `npmAccess` later), so carry it over from that source instead.
  const root = compiled.find(([subpath]) => subpath === ".")?.[1];
  return {
    access: pkg.package.npmAccess,
    ...(typeof root === "object" ? { main: root.default, types: root.types } : {}),
    ...(compiledBin.length ? { bin: Object.fromEntries(compiledBin) } : {}),
    exports: Object.fromEntries(compiled),
  };
}

/**
 * Give a package a compiled publish surface: emit the barrel, ship `lib/`, and
 * advertise it through `publishConfig`.
 *
 * Idempotent - `preSynthesizeProject` reaches every package twice (once from the
 * root's walk, once from the package's own preSynthesize) and both passes must
 * agree.
 */
export function applyCompiledPublish(pkg: javascript.NodeProject): void {
  if (!publishesCompiled(pkg)) return;

  applyCompilerOptions(pkg, COMPILED_COMPILER_OPTIONS);
  applyIncludes(pkg, "index.ts");
  addPackageFiles(pkg, COMPILED_DIR);

  const config = publishConfig(pkg);
  if (config) pkg.package.addField("publishConfig", config);

  // The release workflow publishes straight after `bun install`, with no build
  // in between, so the compiled output has to be produced by the pack itself
  // rather than assumed present. This also covers a bare `pnpm pack` and the
  // bump task's local-registry publish.
  if (!pkg.tasks.tryFind("prepack")) {
    pkg.addTask("prepack", { description: "Compile before packing the published tarball" });
  }
  const prepack = pkg.tasks.tryFind("prepack")!;
  if (prepack.steps.length === 0) prepack.spawn(pkg.compileTask);
}
