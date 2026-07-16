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
 * ({@link withTag}, {@link projectPredicate}).
 * The per-tag table is {@link WORKSPACE_TAG_MIXINS}. Apply with the constructs-native `project.with(...)`
 * across the subtree; the root applies built-in tag mixins during construction and
 * callers add their own afterward.
 */
import type { IMixin as ConstructsMixin } from "constructs";
import { javascript } from "projen";
import { mixin } from "./mixin";
import { applyCompilerOptions, applyTasks, withTag } from "./project";
import { ViteConfigFile } from "./vite";

/** Node compiler options: ES2020 lib + node types, deliberately no DOM. */
const NODE_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2020",
  lib: ["ES2020"],
  types: ["node"],
};

/** The DOM-capable lib list shared by the browser tags (`ui`, `openapi`). */
const DOM_LIB = ["ES2022", "DOM", "DOM.Iterable"];

/**
 * The agnostic floor every package gets at construction: ES2022 stdlib, no DOM, no
 * node types. Also the whole config the `shared` tag applies.
 */
export const AGNOSTIC_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2022",
  lib: ["ES2022"],
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
  ui: mixin(withTag("ui"), (p) => {
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
  }),
  cli: mixin(withTag("cli"), (p) => {
    p.addDeps("commander@catalog:", "@clack/prompts@catalog:");
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
  }),
  server: mixin(withTag("server"), (p) => {
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
  node: mixin(withTag("node"), (p) => {
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
  }),
  shared: mixin(withTag("shared"), (p) => {
    applyCompilerOptions(p, AGNOSTIC_COMPILER_OPTIONS);
  }),
  openapi: mixin(withTag("openapi"), (p) => {
    p.addDeps("openapi-fetch@catalog:");
    applyCompilerOptions(p, { target: "ES2022", lib: [...DOM_LIB], types: [] });
  }),
} satisfies Record<string, ConstructsMixin>;

/** A known workspace-tag name (a key of {@link WORKSPACE_TAG_MIXINS}). */
export type WorkspaceTag = keyof typeof WORKSPACE_TAG_MIXINS;
