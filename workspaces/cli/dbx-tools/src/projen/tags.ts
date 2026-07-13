/**
 * Workspace tags: a single map from tag name to the config packages carrying that
 * tag get automatically. A tag names a target environment (React/Vite, Node,
 * agnostic, ...) - modeled on `databricks apps init` (AppKit): `ui`, `server`,
 * `shared`. There is exactly ONE type - a tag IS its config, no separate "profile"
 * layer. ("Scope" is reserved for the npm `@scope/` in package names.)
 *
 * A `WorkspaceTagDef` is literally a projen `TypeScriptProject` options bag:
 * whatever a tag sets (`deps`/`devDeps`/`peerDeps`, `tsconfig`, ...) is spread
 * straight into the subproject in `applyTags`. The only additions are two keys
 * projen has no native option for: `tasks` (added via `pkg.addTask`) and
 * `viteConfig` (emit a `vite.config.ts`).
 *
 * The `tsconfig` drives each package's generated `lib`/`jsx`/`types`, so
 * enforcement is real: `document` in a `shared`/`server` package fails `tsc` (no
 * DOM lib), and `process`/`node:*` in a `ui` package fails (no node types).
 */
import { type TaskOptions, javascript, typescript } from "projen";

/**
 * A workspace tag's config: a projen `TypeScriptProject` options bag, plus two
 * engine extras projen has no option for (`tasks`, `viteConfig`). Everything else
 * - `deps`, `devDeps`, `peerDeps`, `tsconfig`, ... - is projen's own option,
 * passed straight through.
 */
export type WorkspaceTagDef = Partial<typescript.TypeScriptProjectOptions> & {
  /** Default projen tasks for the tag's packages (name -> projen `TaskOptions`). */
  readonly tasks?: Record<string, TaskOptions>;
  /** Emit a projen-owned `vite.config.ts` for the tag's packages. */
  readonly viteConfig?: boolean;
};

/**
 * Alias of {@link WorkspaceTagDef} - the config `applyTags` applies to a path.
 * Callers pass one (or many) directly to `applyTags` to configure a package
 * without going through auto-discovery.
 */
export type TagDef = WorkspaceTagDef;

/** Node compiler options: ES2020 lib + node types, deliberately no DOM. */
const NODE_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2020",
  lib: ["ES2020"],
  types: ["node"],
};
const DOM_LIB = ["ES2022", "DOM", "DOM.Iterable"] as const;

/** Config for a package whose tag isn't listed below: portable/agnostic. */
export const DEFAULT_WORKSPACE_TAG: WorkspaceTagDef = {
  tsconfig: { compilerOptions: { target: "ES2022", lib: ["ES2022"], types: [] } },
};

/**
 * The workspace-tag table. Drop a `workspaces/<tag>/<name>/src` folder and the
 * package is configured from the tag automatically. `disableWorkspaceTags` in
 * `configureProject` removes entries (their packages fall back to
 * {@link DEFAULT_WORKSPACE_TAG}).
 */
export const WORKSPACE_TAGS = {
  ui: {
    tsconfig: {
      compilerOptions: {
        target: "ES2022",
        lib: [...DOM_LIB],
        jsx: javascript.TypeScriptJsxMode.REACT_JSX,
        types: ["vite/client"],
      },
    },
    deps: ["react@catalog:", "react-dom@catalog:"],
    devDeps: [
      "vite@catalog:",
      "@vitejs/plugin-react@catalog:",
      "@types/react@catalog:",
      "@types/react-dom@catalog:",
    ],
    tasks: {
      dev: { exec: "vite" },
      build: { exec: "vite build" },
      preview: { exec: "vite preview" },
    },
    viteConfig: true,
  },
  cli: {
    tsconfig: { compilerOptions: NODE_COMPILER_OPTIONS },
    deps: ["commander@catalog:", "@clack/prompts@catalog:"],
    devDeps: ["@types/node@catalog:"],
  },
  server: {
    // experimentalDecorators lets tsoa controllers (@Route/@Get/...) type-check;
    // `dbxtools openapi` reads them to generate the openapi tag (spec + client).
    tsconfig: {
      compilerOptions: { ...NODE_COMPILER_OPTIONS, experimentalDecorators: true },
    },
    deps: ["tsoa@catalog:"],
    devDeps: ["@types/node@catalog:"],
  },
  node: {
    tsconfig: { compilerOptions: NODE_COMPILER_OPTIONS },
    devDeps: ["@types/node@catalog:"],
  },
  shared: DEFAULT_WORKSPACE_TAG,
  openapi: {
    tsconfig: { compilerOptions: { target: "ES2022", lib: [...DOM_LIB], types: [] } },
    deps: ["openapi-fetch@catalog:"],
  },
} satisfies Record<string, WorkspaceTagDef>;

/** A known workspace-tag name. */
export type WorkspaceTag = keyof typeof WORKSPACE_TAGS;

/** Resolve a workspace tag's config, defaulting to {@link DEFAULT_WORKSPACE_TAG}. */
export function workspaceTagConfig(
  tag: string,
  tags: Record<string, WorkspaceTagDef> = WORKSPACE_TAGS,
): WorkspaceTagDef {
  return tags[tag] ?? DEFAULT_WORKSPACE_TAG;
}
