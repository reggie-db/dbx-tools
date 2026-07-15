/**
 * Workspace tags, expressed as MIXINS (`constructs` `IMixin`).
 *
 * A tag names a target environment (React/Vite, Node, agnostic, ...) - modeled on
 * `databricks apps init` (AppKit): `ui`, `server`, `shared`. Drop a
 * `workspaces/<tag>/<name>/src` folder and the package is configured from its tag
 * automatically. ("Scope" is reserved for the npm `@scope/` in package names.)
 *
 * Each tag is an {@link IMixin} keyed by name in {@link WORKSPACE_TAG_MIXINS}. The
 * root applies them across the workspace subtree with `project.with(...)`: for every
 * package carrying the tag, the mixin adds the tag's deps and overrides the
 * generated tsconfig (`lib`/`jsx`/`types`, ...). Enforcement is therefore real -
 * `document` in a `shared`/`server` package fails `tsc` (no DOM lib), and
 * `process`/`node:*` in a `ui` package fails (no node types). A package matching
 * several tags gets each mixin in turn (later-wins per tsconfig key).
 *
 * The agnostic floor ({@link AGNOSTIC_COMPILER_OPTIONS}) is applied to every package
 * at construction, so a package with no known tag is still a valid, DOM-free ES2022
 * project; a tag mixin only layers its specifics on top.
 */
import type { IMixin } from "constructs";
import { javascript, typescript, type TaskOptions } from "projen";
import { tagMixin } from "./mixins";
import { emitViteConfig } from "./vite";

/** Override a package's generated tsconfig `compilerOptions` (later-wins per key). */
export function applyCompilerOptions(
  pkg: javascript.NodeProject,
  compilerOptions: javascript.TypeScriptCompilerOptions,
): void {
  if (!(pkg instanceof typescript.TypeScriptProject)) return;
  const file = pkg.tsconfig?.file;
  if (!file) return;
  for (const [key, value] of Object.entries(compilerOptions)) {
    if (value === undefined) continue;
    file.addOverride(`compilerOptions.${key}`, value);
  }
  if (compilerOptions.jsx) pkg.tsconfig?.addInclude("src/**/*.tsx");
}

/** Apply a tag's `tasks` through projen's task system. */
export function applyTasks(pkg: javascript.NodeProject, tasks?: Record<string, TaskOptions>): void {
  if (!tasks) return;
  for (const [name, options] of Object.entries(tasks)) {
    const owned = name === "build" ? pkg.compileTask : pkg.tasks.tryFind(name);
    if (owned) owned.reset(options.exec, options);
    else pkg.addTask(name, options);
  }
}

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
 * are the known tag names; a `workspaces/<tag>/<name>` folder resolves to its tag by
 * this name. Select which apply with the `defaultTagMixins` option (`false` = none,
 * or a subset list; unselected packages fall back to {@link AGNOSTIC_COMPILER_OPTIONS}).
 */
export const WORKSPACE_TAG_MIXINS = {
  ui: tagMixin("ui", (p) => {
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
    emitViteConfig(p);
  }),
  cli: tagMixin("cli", (p) => {
    p.addDeps("commander@catalog:", "@clack/prompts@catalog:");
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
  }),
  server: tagMixin("server", (p) => {
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
  node: tagMixin("node", (p) => {
    p.addDevDeps("@types/node@catalog:");
    applyCompilerOptions(p, NODE_COMPILER_OPTIONS);
  }),
  shared: tagMixin("shared", (p) => {
    applyCompilerOptions(p, AGNOSTIC_COMPILER_OPTIONS);
  }),
  openapi: tagMixin("openapi", (p) => {
    p.addDeps("openapi-fetch@catalog:");
    applyCompilerOptions(p, { target: "ES2022", lib: [...DOM_LIB], types: [] });
  }),
} satisfies Record<string, IMixin>;

/** A known workspace-tag name (a key of {@link WORKSPACE_TAG_MIXINS}). */
export type WorkspaceTag = keyof typeof WORKSPACE_TAG_MIXINS;
