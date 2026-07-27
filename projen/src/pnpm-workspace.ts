/**
 * Inputs for `pnpm-workspace.yaml`, which projen's NATIVE
 * `javascript.PnpmWorkspaceYaml` owns.
 *
 * projen (>= 0.101.16) writes this file itself: every pnpm `NodeProject` gets a
 * `PnpmWorkspaceYaml` component typed by `PnpmWorkspaceYamlSchema`, fed from
 * `pnpmOptions.workspaceYamlOptions`. Nothing here writes a file; this only
 * supplies the options object it renders, so the whole pnpm schema (`overrides`,
 * `packageExtensions`, `catalogs`, ...) stays typed.
 *
 * Three things projen has no API for, and why this state object exists:
 *
 * - **Members are discovered, not declared.** `NodePackage.configurePnpm` passes
 *   `packages` straight through; nothing derives it from `project.subprojects`.
 *   The root's scan attaches packages AFTER construction, so the list is
 *   resolved in `preSynthesize`.
 * - **The catalog is accumulated.** pnpm's `catalog:` has no projen API at all,
 *   and tag mixins plus a consumer's `.projenrc.ts` add pins after construction.
 * - **Build allowances are the `allowBuilds` MAP.** projen's `allowScripts`
 *   renders `onlyBuiltDependencies`, and the pnpm this repo installs with (10.33)
 *   does not read that key at ALL - its only build gate is `allowBuilds`, which
 *   projen's schema does not type. Rendering the list would install with every
 *   build script silently skipped.
 *
 * Late mutation works because projen renders lazily (its `YamlFile` takes
 * `obj: () => toJson_PnpmWorkspaceYamlSchema(options)`) and because
 * `configurePnpm` SPREADS the options into a new object, copying the `packages`
 * array and the `catalog`/`allowBuilds` objects by REFERENCE. Mutating those same
 * objects any time before synth lands in the rendered YAML; reassigning the
 * fields would not.
 *
 * The obvious alternative - drop this and call projen's public
 * `file.addOverride("catalog.<name>", ...)` - is WORSE here, for two measured
 * reasons. `addOverride` SPLITS its path on `.`, so a dependency whose name
 * contains a dot renders as a nested object (`socket.io` -> `socket: {io: ...}`),
 * producing a catalog entry no `catalog:` specifier can resolve, silently. And an
 * override for a key the schema did not already emit is appended LAST, which
 * buries `packages` under the catalog. Keys set here are plain object keys, so
 * neither applies.
 */
import { relative } from "node:path";
import { javascript, type Project } from "projen";
import { toPosix } from "./packages";

/**
 * The pnpm `catalog:` version registry: dependency name -> version range. A
 * pnpm-workspace feature (packages reference it via a `catalog:` specifier), so
 * there is no projen type for it - it's just a string map.
 */
export type Catalog = Record<string, string>;

/**
 * pnpm's `allowBuilds`: dependency name -> may its install scripts run. Not in
 * projen's schema, whose build gate is the `onlyBuiltDependencies` LIST that
 * current pnpm ignores.
 */
export type AllowBuilds = Record<string, boolean>;

/**
 * Default pnpm `catalog:` versions, pinned to match `databricks apps init`
 * (AppKit). The `@databricks/*` packages are hardcoded engine defaults: this
 * engine is steered toward Databricks, so AppKit + the experimental SDK are
 * always available at `catalog:` without a per-repo override.
 */
const DEFAULT_CATALOG: Catalog = {
  react: "^19.2.4",
  "react-dom": "^19.2.4",
  "@types/react": "^19.2.2",
  "@types/react-dom": "^19.2.2",
  vite: "^7.1.14",
  "@vitejs/plugin-react": "^5.0.4",
  "@types/node": "^24.6.0",
  "@types/express": "^5.0.5",
  express: "^5.1.0",
  // Exact, not a range: AppKit pins `zod` to a single version, and a schema
  // built against a different copy is a structurally identical but nominally
  // distinct type, so passing one to `defineTool` needs a cast. Matching the
  // pin keeps one zod in the tree and the boundary cast-free. Still inside
  // `@mastra/core`'s `^3.25.0 || ^4.0.0` peer range.
  zod: "4.3.6",
  typescript: "^5.9.3",
  tsx: "^4.23.0",
  commander: "^15.0.0",
  "@clack/prompts": "^1.7.0",
  "openapi-fetch": "^0.17.0",
  tsoa: "^6.6.0",
  concurrently: "^10.0.3",
  pnpm: "^11.0.6",
  // Optional logger: shared-core's `log` module lazy-imports it and degrades to
  // a console fallback when it's absent, so consumers can leave it uninstalled.
  consola: "^3.4.2",
  "@databricks/appkit": "^0.43.0",
  "@databricks/appkit-ui": "^0.43.1",
  "@databricks/sdk-experimental": "^0.17.0",
};

/**
 * Build allowances every workspace needs. Only `esbuild`, which tsx pulls in and
 * which therefore has to be built for any task to run.
 */
const DEFAULT_ALLOW_BUILDS: AllowBuilds = { esbuild: true };

/**
 * pnpm settings this engine applies to every workspace, beyond members, catalog,
 * and allowances. Each is stated because pnpm's own default is the weaker choice
 * for a projen-managed monorepo; a caller's `workspaceYaml` overrides any.
 */
const DEFAULT_WORKSPACE_YAML: javascript.PnpmWorkspaceYamlOptions = {
  // The catalog is GENERATED (`addCatalog` in `.projenrc.ts` / a tag mixin), so
  // `pnpm add` must never write to it - `manual` keeps pnpm out of a file projen
  // owns. Also pnpm's own default; stated so a future pnpm default flip cannot
  // start editing generated content.
  catalogMode: javascript.PnpmWorkspaceYamlSchemaCatalogMode.MANUAL,
  // Every package resolves its siblings from source (`workspace:*` + an
  // `index.ts` entrypoint), so a stale `node_modules` after a branch switch
  // shows up as a warning on the next task rather than a confusing type error.
  verifyDepsBeforeRun: "warn",
  // `strictDepBuilds` is deliberately absent. It turns any dependency with an
  // unreviewed install script into a hard install failure, which forces EVERY
  // such package to be declared, including ones only ever declined. Left off,
  // pnpm warns ("Ignored build scripts: ...") and installs, so `allowBuilds`
  // holds real allowances only.
};

/** Options for the engine's `pnpm-workspace.yaml` contributions. */
export interface DBXToolsPNPMWorkspaceOptions {
  /** Initial `catalog:` registry. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /** Initial build allowances, merged over `{ esbuild: true }`. */
  readonly allowBuilds?: AllowBuilds;
  /** Any other pnpm-workspace setting, typed by projen's schema. */
  readonly workspaceYaml?: javascript.PnpmWorkspaceYamlOptions;
}

/**
 * The accumulated members, catalog, and build allowances behind the root's
 * `pnpm-workspace.yaml`, exposed as `project.pnpmWorkspace`. ROOT-only, so the
 * field is `undefined` on a child package (like projen's `project.eslint`).
 *
 * NOT a projen component and NOT a file: projen's native `PnpmWorkspaceYaml`
 * owns both, and this owns only the options object it renders.
 */
export class PnpmWorkspaceState {
  /**
   * The options object handed to projen, whose members are mutated in place.
   * Held as the live reference the native component captured.
   *
   * Widened with `allowBuilds`, which projen's schema type does not declare;
   * projen renders unrecognized keys verbatim, so it reaches the file.
   */
  readonly options: javascript.PnpmWorkspaceYamlOptions & { allowBuilds: AllowBuilds };

  private readonly packages: string[] = [];
  private readonly catalog: Catalog;
  private readonly allowBuilds: AllowBuilds;

  constructor(options: DBXToolsPNPMWorkspaceOptions = {}) {
    this.catalog = { ...DEFAULT_CATALOG, ...options.catalog };
    this.allowBuilds = { ...DEFAULT_ALLOW_BUILDS, ...options.allowBuilds };
    this.options = {
      ...DEFAULT_WORKSPACE_YAML,
      ...options.workspaceYaml,
      packages: this.packages,
      catalog: this.catalog,
      allowBuilds: this.allowBuilds,
    };
  }

  /** Add or override a `catalog:` entry (dependency name -> version range). */
  public addCatalog(name: string, version: string): void {
    this.catalog[name] = version;
  }

  /**
   * Let a dependency's install scripts run.
   *
   * Only allowances are declared. A dependency that is never allowed needs no
   * entry: without `strictDepBuilds`, pnpm warns and skips it.
   */
  public allowBuild(name: string): void {
    this.allowBuilds[name] = true;
  }

  /**
   * Fill `packages` from the project's attached subprojects.
   *
   * Called from the root's `preSynthesize`, which is the earliest point every
   * discovered package is attached - the list cannot be captured at
   * construction, since the root's scan runs after it.
   */
  public resolveMembers(project: Project): void {
    const members = project.subprojects
      .map((sub) => toPosix(relative(project.outdir, sub.outdir)))
      .filter(Boolean);
    // Replaces the array's CONTENTS, keeping the reference projen captured.
    this.packages.splice(0, this.packages.length, ...new Set(members.sort()));
  }
}
