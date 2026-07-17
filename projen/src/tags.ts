/**
 * Workspace tags, expressed as MIXINS (`constructs` `IMixin`).
 *
 * A tag names a target environment (React/Vite, Node, agnostic, ...) - modeled on
 * `databricks apps init` (AppKit): `ui`, `server`, `shared`. Any `src`-bearing folder
 * under a workspace-package root is discovered automatically; path-derived tag
 * candidates plus `workspacePackageTagPaths` decide which mixins apply. ("Scope" is
 * reserved for the npm `@scope/` in package names.)
 *
 * Mixin factories live in {@link ./mixin}; package predicates live in {@link ./project}
 * ({@link projectPredicate.hasTag}, {@link projectPredicate.hasIdentifierPackageName}).
 * The per-tag table is {@link WORKSPACE_TAG_MIXINS}. Apply with the constructs-native `project.with(...)`
 * across the subtree; the root applies built-in tag mixins during construction and
 * callers add their own afterward.
 */
import type { IMixin as ConstructsMixin } from "constructs";
import { javascript } from "projen";
import { create } from "./mixin";
import { applyCompilerOptions, applyExports, applyTasks } from "./project";
import * as projectPredicate from "./project-predicate";
import { ViteConfigFile } from "./vite";

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
 * The workspace-tag table, as mixins. Each entry configures every package carrying
 * that tag (deps + tsconfig + tasks) when applied via `project.with(...)`. The keys
 * are the known tag names; a package carrying a given tag receives its mixin when
 * that tag appears in `dbxToolsConfig.tags`. Select which apply with the `defaultTagMixins` option (`false` = none,
 * or a subset list; unselected packages fall back to {@link AGNOSTIC_COMPILER_OPTIONS}).
 */
export const WORKSPACE_TAG_MIXINS = {
  // `ui`: a React COMPONENT LIBRARY (source-first, consumed by apps) - modeled
  // on `@databricks/appkit-ui`. React + DOM lib + JSX, and the default `tsc`
  // compile (typecheck). No vite app build / index.html: a full browser app is an
  // `app`-tagged package (see below) that layers vite on top.
  ui: create(projectPredicate.hasTag("ui"), (p) => {
    p.addDeps("react@catalog:", "react-dom@catalog:");
    p.addDevDeps("@types/react@catalog:", "@types/react-dom@catalog:");
    applyCompilerOptions(p, {
      target: "ES2022",
      lib: [...DOM_LIB],
      jsx: javascript.TypeScriptJsxMode.REACT_JSX,
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
  // `app`: a full browser app built + served by Vite (needs an `index.html`
  // entry). Self-contained React app: React + DOM lib + JSX + the vite toolchain
  // and app tasks (`dev`/`build`/`preview`). `build` resets the compile task, so
  // `compile` bundles with vite rather than `tsc`.
  app: create(projectPredicate.hasTag("app"), (p) => {
    p.addDeps("react@catalog:", "react-dom@catalog:");
    p.addDevDeps(
      "vite@catalog:",
      "@vitejs/plugin-react@catalog:",
      "@types/react@catalog:",
      "@types/react-dom@catalog:",
    );
    applyCompilerOptions(p, {
      target: "ES2022",
      lib: [...DOM_LIB],
      jsx: javascript.TypeScriptJsxMode.REACT_JSX,
      types: ["vite/client"],
    });
    applyTasks(p, {
      dev: { exec: "vite" },
      build: { exec: "vite build" },
      preview: { exec: "vite preview" },
    });
    new ViteConfigFile(p);
    // An app has a single root entry, not a component library's subpaths - so it
    // replaces the `ui` tag's `./react`/`./styles.css` surface with a `.` root.
    applyExports(p, {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
  }),
  cli: create(projectPredicate.hasTag("cli"), (p) => {
    p.addDeps("commander@catalog:", "@clack/prompts@catalog:");
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
    // A CLI's standard surface: a `.` root entry plus `./package.json`. A CLI
    // that also exports a helper module (e.g. dbx-tools' `./pnpm`) overrides
    // this in its own mixin.
    applyExports(p, {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
  }),
  server: create(projectPredicate.hasTag("server"), (p) => {
    // A Node/Express service. tsoa's decorators (@Route/@Get/...) also drive
    // `dbxtools openapi` (spec + client); experimentalDecorators lets them
    // type-check. `dev`/`start` run the app's `src/server.ts` with tsx.
    p.addDeps("express@catalog:", "tsoa@catalog:");
    p.addDevDeps("@types/node@catalog:", "@types/express@catalog:");
    applyCompilerOptions(p, {
      ...NODE_COMPILER_OPTIONS,
      experimentalDecorators: true,
    });
    applyTasks(p, {
      dev: { exec: "tsx watch src/server.ts" },
      start: { exec: "tsx src/server.ts" },
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

/** A known workspace-tag name (a key of {@link WORKSPACE_TAG_MIXINS}). */
export type WorkspaceTag = keyof typeof WORKSPACE_TAG_MIXINS;
