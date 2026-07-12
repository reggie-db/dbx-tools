/**
 * Scopes: a single map from folder name (under `packages/`) to the config that
 * folder's packages get automatically. There is exactly ONE type here - a scope
 * IS its config; there is no separate "profile" layer.
 *
 * Modeled on `databricks apps init` (AppKit): `ui` (Vite/React), `server`
 * (Express/Node), `shared` (agnostic). The config drives each package's
 * generated `tsconfig.json` (`lib`/`jsx`/`types`) + baseline deps/scripts, so
 * enforcement is real: `document` in a `shared`/`server` package fails `tsc`
 * (no DOM lib), and `process`/`node:*` in a `ui` package fails (no node types).
 */

/** A dependency map: name -> range / `workspace:*` / `catalog:`. */
export type Deps = Record<string, string>;

/** Everything a scope contributes to a package. */
export interface ScopeDef {
  /** `compilerOptions` overlaid on `tsconfig.base.json`. */
  readonly compilerOptions: Record<string, unknown>;
  readonly dependencies?: Deps;
  readonly devDependencies?: Deps;
  readonly peerDependencies?: Deps;
  /** Default `scripts` a package in this scope gets. */
  readonly scripts?: Record<string, string>;
  /** Generate a `vite.config.ts` for packages in this scope. */
  readonly viteConfig?: boolean;
}

const NODE = { target: "ES2020", lib: ["ES2020"], types: ["node"] } as const;
const DOM_LIB = ["ES2022", "DOM", "DOM.Iterable"] as const;

/**
 * The scope table. Add a key and drop a `packages/<key>/<name>/src` folder - the
 * package is configured automatically. `disableScopes` in `configureProjen`
 * removes entries (their folders fall back to {@link DEFAULT_SCOPE}).
 */
export const SCOPES = {
  ui: {
    compilerOptions: { target: "ES2022", lib: [...DOM_LIB], jsx: "react-jsx", types: ["vite/client"] },
    dependencies: { react: "catalog:", "react-dom": "catalog:" },
    devDependencies: {
      vite: "catalog:",
      "@vitejs/plugin-react": "catalog:",
      "@types/react": "catalog:",
      "@types/react-dom": "catalog:",
    },
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    viteConfig: true,
  },
  cli: {
    compilerOptions: { ...NODE },
    dependencies: { commander: "catalog:", "@clack/prompts": "catalog:" },
    devDependencies: { "@types/node": "catalog:" },
  },
  server: {
    compilerOptions: { ...NODE },
    devDependencies: { "@types/node": "catalog:" },
  },
  node: {
    compilerOptions: { ...NODE },
    devDependencies: { "@types/node": "catalog:" },
  },
  shared: {
    compilerOptions: { target: "ES2022", lib: ["ES2022"], types: [] },
  },
  openapi: {
    compilerOptions: { target: "ES2022", lib: [...DOM_LIB], types: [] },
    dependencies: { "openapi-fetch": "catalog:" },
  },
} as const satisfies Record<string, ScopeDef>;

/** A known scope name. */
export type Scope = keyof typeof SCOPES;

/** Config for a folder whose scope isn't listed above: portable/agnostic. */
export const DEFAULT_SCOPE: ScopeDef = {
  compilerOptions: { target: "ES2022", lib: ["ES2022"], types: [] },
};

/** Resolve a scope's config, defaulting to {@link DEFAULT_SCOPE}. */
export function scopeConfig(
  scope: string,
  scopes: Record<string, ScopeDef> = SCOPES,
): ScopeDef {
  return scopes[scope] ?? DEFAULT_SCOPE;
}
