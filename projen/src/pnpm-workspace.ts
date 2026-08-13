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
import { toPosix } from "./packages.ts";

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
  // Tailwind v4 compiler for bun's dev server + `Bun.build` (the `app` tag).
  "bun-plugin-tailwind": "^0.1.2",
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
  "@databricks/appkit": "^0.60.0",
  "@databricks/appkit-ui": "^0.60.0",
  "@databricks/sdk-experimental": "^0.17.0",
};

/**
 * Build allowances every workspace needs. These matter for the Databricks Apps
 * pnpm install (which reads `pnpm-workspace.yaml`) and for bun (mirrored into the
 * root `package.json` `trustedDependencies`): `unrs-resolver` is the native
 * binding behind `eslint-import-resolver-typescript`, which projen's eslint
 * component adds to every generated project, and `esbuild` is still pulled in by
 * parts of the toolchain. Leaving either unlisted greets a freshly bootstrapped
 * workspace with an "Ignored build scripts" warning on its first install.
 */
const DEFAULT_ALLOW_BUILDS: AllowBuilds = {
  esbuild: true,
  "unrs-resolver": true,
  // The `bun` npm package (a peer of `bun-plugin-tailwind`) ships a `bun.exe`
  // placeholder and downloads the real platform binary in its postinstall. Left
  // unbuilt, that `.exe` shim lands in `node_modules/.bin/bun` and makes projen's
  // dax PATH walk `spawn ENOEXEC` on macOS/Linux, breaking EVERY task. Building it
  // replaces the shim with a runnable binary.
  bun: true,
  // fastembed's native ONNX runtime (via `@mastra/fastembed`).
  "onnxruntime-node": true,
};

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
  private readonly overrides: Record<string, string>;

  constructor(options: DBXToolsPNPMWorkspaceOptions = {}) {
    this.catalog = { ...DEFAULT_CATALOG, ...options.catalog };
    this.allowBuilds = { ...DEFAULT_ALLOW_BUILDS, ...options.allowBuilds };
    // Seeded even when empty so `addOverride` has a reference projen already
    // captured; projen's `omitEmpty` drops the key while it stays empty.
    this.overrides = { ...options.workspaceYaml?.overrides };
    this.options = {
      ...DEFAULT_WORKSPACE_YAML,
      ...options.workspaceYaml,
      packages: this.packages,
      catalog: this.catalog,
      allowBuilds: this.allowBuilds,
      overrides: this.overrides,
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
   * Force every resolution of `name` to `version`, workspace-wide (pnpm
   * `overrides`) - the escape hatch for a transitive dependency you do not
   * declare, e.g. pinning past an unmet peer range a dependency has not yet
   * widened.
   *
   * Blunt by design: it applies to EVERY package in the workspace, including
   * ones whose declared range excludes it, so reach for a catalog entry first
   * when the dependency is one you actually declare.
   *
   * Note this is a pnpm override, unrelated to projen's `FileBase.addOverride`.
   */
  public addOverride(name: string, version: string): void {
    this.overrides[name] = version;
  }

  /**
   * Emit `pnpm-workspace.yaml` directly.
   *
   * Under bun, projen's base `NodePackage` never runs `configurePnpm` (that call
   * site is gated to `packageManager === PNPM`), so no `PnpmWorkspaceYaml`
   * component is created. This engine still needs the file for the Databricks
   * Apps platform, whose build phase installs with pnpm and reads the catalog +
   * `allowBuilds`. The native component is just a `YamlFile` fed by a lazy
   * `toJson(options)`, so constructing it directly (with the same options object
   * whose arrays/objects are mutated in place up to synth) produces the identical
   * file. Idempotent: skips if a `pnpm-workspace.yaml` component already exists
   * (e.g. a future projen that DOES create it under bun).
   */
  public attachWorkspaceFile(project: Project): void {
    const exists = project.files.some((file) => file.path === "pnpm-workspace.yaml");
    if (!exists) new javascript.PnpmWorkspaceYaml(project, this.options);
  }

  /**
   * Fill `packages` from the project's attached subprojects, then mirror the
   * workspace shape into the root `package.json` so bun (which reads
   * `workspaces`/`catalog` from the manifest, not `pnpm-workspace.yaml`) resolves
   * the same members + catalog. `trustedDependencies` (bun's `allowBuilds` analog)
   * is rendered by projen from its own allowlist, so the build allowances are
   * routed there via `addAllowedScripts`.
   *
   * Called from the root's `preSynthesize`, which is the earliest point every
   * discovered package is attached - the list cannot be captured at
   * construction, since the root's scan runs after it.
   */
  public resolveMembers(project: Project, extraMembers: readonly string[] = []): void {
    const members = project.subprojects
      .filter((sub): sub is javascript.NodeProject => sub instanceof javascript.NodeProject)
      .map((sub) => toPosix(relative(project.outdir, sub.outdir)))
      .filter(Boolean);
    // `extraMembers` are workspace siblings NOT attached as subprojects (e.g. the
    // self-synthesizing `projen/` engine), so they must be added explicitly.
    const all = [...members, ...extraMembers.map((m) => toPosix(m)).filter(Boolean)];
    // Replaces the array's CONTENTS, keeping the reference projen captured.
    this.packages.splice(0, this.packages.length, ...new Set(all.sort()));
    this.mirrorToPackageJson(project);
  }

  /**
   * Write `workspaces` / `catalog` / `overrides` into the root `package.json`
   * (bun's source of truth) and feed the build allowances into projen's
   * allowlist so bun's native `trustedDependencies` renders them.
   */
  private mirrorToPackageJson(project: Project): void {
    const pkg = (project as { package?: javascript.NodePackage }).package;
    if (!pkg) return;
    pkg.addField("workspaces", [...this.packages]);
    if (Object.keys(this.catalog).length > 0) {
      pkg.addField("catalog", { ...this.catalog });
    }
    if (Object.keys(this.overrides).length > 0) {
      pkg.addField("overrides", { ...this.overrides });
    }
    // projen renders bun's `trustedDependencies` from `allowedScripts`.
    const allowed = Object.entries(this.allowBuilds)
      .filter(([, on]) => on)
      .map(([name]) => name);
    if (allowed.length > 0) pkg.addAllowedScripts(...allowed);
  }
}
