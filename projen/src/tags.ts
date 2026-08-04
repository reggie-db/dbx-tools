/**
 * Tags, expressed as MIXINS (`constructs` `IMixin`).
 *
 * A tag names a target environment (React/Bun, Node, agnostic, ...) - modeled on
 * `databricks apps init` (AppKit): `ui`, `server`, `shared`. Any `src`-bearing folder
 * under a package root is discovered automatically; path-derived tag
 * candidates plus `packageTagPaths` decide which mixins apply. ("Scope" is
 * reserved for the npm `@scope/` in package names.)
 *
 * Mixin factories live in {@link ./mixin}; package predicates live in {@link ./project}
 * ({@link projectPredicate.hasTag}).
 * The per-tag table is {@link PACKAGE_TAG_MIXINS}. Apply with the constructs-native `project.with(...)`
 * across the subtree; the root applies built-in tag mixins during construction and
 * callers add their own afterward.
 */
import type { IMixin as ConstructsMixin } from "constructs";
import { javascript } from "projen";
import { BunBuildFile, BunDevServerFile, BunfigFile } from "./bun-app.ts";
import { create } from "./mixin.ts";
import * as projectPredicate from "./project-predicate.ts";
import {
  addPackageFiles,
  applyCompilerOptions,
  applyExports,
  applyIncludes,
  applyTasks,
  srcModuleExports,
} from "./project.ts";

/** Node compiler options: ES2022 lib + node types, deliberately no DOM. */
const NODE_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2022",
  lib: ["ES2022"],
  types: ["node"],
};

/** The DOM-capable lib list shared by the browser tags (`ui`, `openapi`). */
const DOM_LIB = ["ES2022", "DOM", "DOM.Iterable"];

/**
 * The agnostic floor every package gets at construction: ES2022 stdlib plus the
 * web-platform globals available in every JS runtime (browser, workers, Node 18+)
 * via the `WebWorker` lib - `AbortController`/`AbortSignal`, `URL`, `crypto`, the
 * timer functions, `fetch`, `TextEncoder`, etc. Deliberately NO `DOM` lib (no
 * `document`/`window`) and no node types, so agnostic code stays isomorphic. Also
 * the whole config the `shared` tag applies.
 */
export const AGNOSTIC_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2022",
  lib: ["ES2022", "WebWorker"],
  types: [],
};

/**
 * The tag table, as mixins. Each entry configures every package carrying
 * that tag (deps + tsconfig + tasks) when applied via `project.with(...)`. The keys
 * are the known tag names; a package carrying a given tag receives its mixin when
 * that tag appears in `dbxToolsConfig.tags`. Select which apply with the `defaultTagMixins` option (`false` = none,
 * or a subset list; unselected packages fall back to {@link AGNOSTIC_COMPILER_OPTIONS}).
 */
export const PACKAGE_TAG_MIXINS = {
  // `ui`: a React COMPONENT LIBRARY (source-first, consumed by apps) - modeled
  // on `@databricks/appkit-ui`. React + DOM lib + JSX, and the default `tsc`
  // compile (typecheck). No app build / index.html: a full browser app is an
  // `app`-tagged package (see below) that layers Bun's build tooling on top.
  ui: create(projectPredicate.hasTag("ui"), (p) => {
    p.addDeps("react@catalog:", "react-dom@catalog:");
    p.addDevDeps("@types/react@catalog:", "@types/react-dom@catalog:");
    // `jsx` is not set here: it is in the shared floor for EVERY package, because
    // packages resolve each other to source and so every consumer of a `.tsx`
    // module needs it too (see SHARED_COMPILER_OPTIONS). What this tag adds is the
    // browser part - the DOM lib and React's types.
    applyCompilerOptions(p, {
      target: "ES2022",
      lib: [...DOM_LIB],
    });
    // A component library's standard subpath surface: `./react` (components),
    // `./styles.css` (Tailwind entry), and `./package.json`. A package that
    // ships more (e.g. ui-appkit's `./vite` preset) overrides this in its own
    // mixin; an `app`-tagged package replaces it with a `.` root (see below).
    applyExports(p, {
      "./react": "./src/react/index.ts",
      "./styles.css": "./src/styles.css",
      "./package.json": "./package.json",
    });
  }),
  // `app`: a full browser app built + served by BUN (needs an `index.html`
  // entry). Self-contained React app: React + DOM lib + JSX + bun's fullstack
  // dev server (`dev.ts`, `Bun.serve` + HMR) and production bundle (`build.ts`,
  // `Bun.build`). Tailwind v4 is compiled by `bun-plugin-tailwind` (wired in the
  // generated `bunfig.toml`). No Vite.
  app: create(projectPredicate.hasTag("app"), (p) => {
    p.addDeps("react@catalog:", "react-dom@catalog:");
    p.addDevDeps(
      "@types/react@catalog:",
      "@types/react-dom@catalog:",
      // The Tailwind plugin the dev server + build load. Tailwind itself is a
      // catalog dep the app declares (it also owns the Tailwind entry CSS).
      "bun-plugin-tailwind@catalog:",
    );
    applyCompilerOptions(p, {
      target: "ES2022",
      lib: [...DOM_LIB],
      // `@types/bun` (a root/subproject devDep) supplies the `Bun.*` globals the
      // generated `dev.ts`/`build.ts` use; no `vite/client`.
      types: ["bun"],
      // `@/` -> `src/` alias, resolved by both tsc and bun's bundler (bun reads
      // tsconfig `paths`).
      baseUrl: ".",
      paths: { "@/*": ["./src/*"] },
    });
    // bun runs the generated scripts directly. `build` resets the compile task so
    // `compile` bundles with `Bun.build` rather than `tsc`.
    //
    // No `preview` task: that pairing is Vite's, where `dev` runs the dev server
    // and `preview` serves the already-built bundle. `Bun.serve` builds on request,
    // so `preview` could only be spelled the same as `dev` - two names for one
    // command, and a reader would reasonably assume the second one served `dist/`.
    applyTasks(p, {
      dev: { exec: "bun dev.ts" },
      build: { exec: "bun build.ts" },
    });
    new BunfigFile(p);
    new BunDevServerFile(p);
    new BunBuildFile(p);
    // An app has a single root entry, not a component library's subpaths - so it
    // replaces the `ui` tag's `./react`/`./styles.css` surface with a `.` root.
    applyExports(p, {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
  }),
  cli: create(projectPredicate.hasTag("cli"), (p) => {
    // No tsx: a CLI's `bin` resolves to its emitted `lib/bin/<name>.js` in the
    // published tarball (see `publishConfig` in {@link applyCompiledPublish}), so
    // the installed CLI is plain JavaScript Node runs directly - no loader to
    // register and no launcher shim to generate. In a WORKSPACE checkout the
    // manifest still points at the `.ts` entry, which Node type-strips on its own
    // because the package is not under `node_modules`.
    p.addDeps("commander@catalog:");
    p.addDevDeps("@types/node@catalog:");
    // A CLI compiles code OUTSIDE `src/` - its root `index.ts` barrel and the
    // `bin/` entries - which the src-only tag default doesn't reach.
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
    applyIncludes(p, "index.ts", "bin/**/*.ts");
    // A CLI's standard surface: the `.` root entry, a `./<module>` subpath per
    // top-level `src` module, and `./package.json`. Derived rather than declared
    // so no CLI has to hand-list its own modules.
    applyExports(p, {
      ".": "./index.ts",
      ...srcModuleExports(p),
      "./package.json": "./package.json",
    });
    // A CLI is the one shape whose entry point lives outside `src`, so its
    // `bin/` tree has to be added to the tarball allowlist explicitly.
    addPackageFiles(p, "bin");
  }),
  server: create(projectPredicate.hasTag("server"), (p) => {
    // A Node/Express service. tsoa's decorators (@Route/@Get/...) also drive
    // the `openapi` task (spec + client); experimentalDecorators lets them
    // type-check. `dev`/`start` run the app's `src/server.ts` with tsx.
    p.addDeps("express@catalog:", "tsoa@catalog:");
    p.addDevDeps("@types/node@catalog:", "@types/express@catalog:");
    applyCompilerOptions(p, {
      ...NODE_COMPILER_OPTIONS,
      experimentalDecorators: true,
    });
    // bun runs the server `.ts` directly (native TS, no tsx). `--watch` restarts
    // on change - the tsx-watch replacement.
    applyTasks(p, {
      dev: { exec: "bun --watch src/server.ts" },
      start: { exec: "bun src/server.ts" },
    });
  }),
  node: create(projectPredicate.hasTag("node"), (p) => {
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
  }),
  shared: create(projectPredicate.hasTag("shared"), (p) => {
    applyCompilerOptions(p, AGNOSTIC_COMPILER_OPTIONS);
  }),
  openapi: create(projectPredicate.hasTag("openapi"), (p) => {
    p.addDeps("openapi-fetch@catalog:");
    applyCompilerOptions(p, { target: "ES2022", lib: [...DOM_LIB], types: [] });
  }),
} satisfies Record<string, ConstructsMixin>;

/** A known tag name (a key of {@link PACKAGE_TAG_MIXINS}). */
export type PackageTag = keyof typeof PACKAGE_TAG_MIXINS;
