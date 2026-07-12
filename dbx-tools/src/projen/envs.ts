/**
 * Workspace envs: a single map from env name (a folder under a workspace-env root
 * like `workspaces/`) to the config that env's packages get automatically.
 * Bit-style, an "env" names the target environment (React/Vite, Node, agnostic,
 * ...); there is exactly ONE type here - an env IS its config, no separate
 * "profile" layer. ("Scope" is reserved for the npm `@scope/` in package names.)
 *
 * A `WorkspaceEnvDef` is literally a projen `TypeScriptProject` options bag:
 * whatever an env sets (`deps`/`devDeps`/`peerDeps`, `tsconfig`, ...) is spread
 * straight into the subproject in `definePackage`. The only additions are two keys
 * projen has no native option for: `tasks` (added via `pkg.addTask`) and
 * `viteConfig` (emit a `vite.config.ts`).
 *
 * Modeled on `databricks apps init` (AppKit): `ui` (Vite/React), `server`
 * (Express/Node), `shared` (agnostic). The `tsconfig` drives each package's
 * generated `lib`/`jsx`/`types`, so enforcement is real: `document` in a
 * `shared`/`server` package fails `tsc` (no DOM lib), and `process`/`node:*` in a
 * `ui` package fails (no node types).
 */
import { type TaskOptions, javascript, typescript } from "projen";

/**
 * A workspace env's config: a projen `TypeScriptProject` options bag, plus two
 * engine extras projen has no option for (`tasks`, `viteConfig`). Everything else
 * - `deps`, `devDeps`, `peerDeps`, `tsconfig`, ... - is projen's own option,
 * passed straight through.
 */
export type WorkspaceEnvDef = Partial<typescript.TypeScriptProjectOptions> & {
  /** Default projen tasks for the env's packages (name -> projen `TaskOptions`). */
  readonly tasks?: Record<string, TaskOptions>;
  /** Emit a projen-owned `vite.config.ts` for the env's packages. */
  readonly viteConfig?: boolean;
};

/** Node compiler options: ES2020 lib + node types, deliberately no DOM. */
const NODE_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ES2020",
  lib: ["ES2020"],
  types: ["node"],
};
const DOM_LIB = ["ES2022", "DOM", "DOM.Iterable"] as const;

/** Config for a folder whose env isn't listed below: portable/agnostic. */
export const DEFAULT_WORKSPACE_ENV: WorkspaceEnvDef = {
  tsconfig: { compilerOptions: { target: "ES2022", lib: ["ES2022"], types: [] } },
};

/**
 * The workspace-env table. Add a key and drop a `workspaces/<env>/<name>/src`
 * folder - the package is configured automatically. `disableWorkspaceEnvs` in
 * `configureProjen` removes entries (their folders fall back to
 * {@link DEFAULT_WORKSPACE_ENV}).
 */
export const WORKSPACE_ENVS = {
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
    tsconfig: { compilerOptions: NODE_COMPILER_OPTIONS },
    devDeps: ["@types/node@catalog:"],
  },
  node: {
    tsconfig: { compilerOptions: NODE_COMPILER_OPTIONS },
    devDeps: ["@types/node@catalog:"],
  },
  shared: DEFAULT_WORKSPACE_ENV,
  openapi: {
    tsconfig: { compilerOptions: { target: "ES2022", lib: [...DOM_LIB], types: [] } },
    deps: ["openapi-fetch@catalog:"],
  },
} satisfies Record<string, WorkspaceEnvDef>;

/** A known workspace-env name. */
export type WorkspaceEnv = keyof typeof WORKSPACE_ENVS;

/** Resolve a workspace env's config, defaulting to {@link DEFAULT_WORKSPACE_ENV}. */
export function workspaceEnvConfig(
  env: string,
  envs: Record<string, WorkspaceEnvDef> = WORKSPACE_ENVS,
): WorkspaceEnvDef {
  return envs[env] ?? DEFAULT_WORKSPACE_ENV;
}
