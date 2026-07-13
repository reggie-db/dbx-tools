/**
 * `pnpm-workspace.yaml` as a first-class projen file component.
 *
 * `DBXToolsPNPMWorkspace` extends projen's `YamlFile` and is exposed as the
 * `pnpmWorkspace` field on both project classes, so a mixin or a consumer's
 * `.projenrc.ts` can tweak it uniformly (`project.pnpmWorkspace.addCatalog(...)`,
 * `.allowBuild(...)`, `.addPackage(...)`, or `file.addOverride(...)` for any other
 * pnpm setting). Its `packages` list is NOT hardcoded: it is recomputed from
 * `project.subprojects` at synth time (projen resolves the `obj` thunk late, by
 * which point every subproject is attached), so any package - discovered by the
 * root's scan or attached manually - lands here automatically.
 *
 * Replaces the old `files.pnpmWorkspace()` free function + `ModifyPnpmWorkspace`
 * option (both removed): mutation now goes through the typed instance methods.
 */
import { relative } from "node:path";
import { type Project, YamlFile } from "projen";
import { toPosix } from "./workspace";

/**
 * The pnpm `catalog:` version registry: dependency name -> version range. A
 * pnpm-workspace feature (packages reference it via a `catalog:` specifier), so
 * there is no projen type for it - it's just a string map.
 */
export type Catalog = Record<string, string>;

/** Default pnpm `catalog:` versions, pinned to match `databricks apps init` (AppKit). */
export const DEFAULT_CATALOG: Catalog = {
  react: "^19.2.4",
  "react-dom": "^19.2.4",
  "@types/react": "^19.2.2",
  "@types/react-dom": "^19.2.2",
  vite: "^7.1.14",
  "@vitejs/plugin-react": "^5.0.4",
  "@types/node": "^24.6.0",
  "@types/express": "^5.0.5",
  express: "^5.1.0",
  zod: "^4.3.6",
  typescript: "^5.9.3",
  commander: "^15.0.0",
  "@clack/prompts": "^1.7.0",
  "openapi-fetch": "^0.17.0",
  tsoa: "^6.6.0",
  pnpm: "^11.0.6",
};

/**
 * Default pnpm v11 build-script allowlist: only `esbuild` (pulled in by tsx).
 * pnpm v11 gates build scripts behind `allowBuilds` and errors on a
 * non-interactive install until each is explicitly allowed.
 */
const DEFAULT_ALLOW_BUILDS: Record<string, boolean> = { esbuild: true };

/**
 * The `pnpm-workspace.yaml` object this engine writes. The three fields it always
 * manages are typed; the index signature lets a mixin attach any other
 * pnpm-workspace setting (`overrides`, `packageExtensions`, ...) via
 * `file.addOverride(...)`.
 */
export interface PnpmWorkspaceConfig {
  /** Workspace members (what pnpm links). Sourced from `project.subprojects`. */
  packages: string[];
  /** The `catalog:` version registry every `catalog:` specifier resolves against. */
  catalog: Catalog;
  /** pnpm v11 build-script allowlist: dependency name -> allowed. */
  allowBuilds: Record<string, boolean>;
  [key: string]: unknown;
}

/** Options for {@link DBXToolsPNPMWorkspace}. */
export interface DBXToolsPNPMWorkspaceOptions {
  /** Initial packages list. Defaults to empty. */
  readonly packages?: string[];
  /** Initial `catalog:` registry. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /** Initial build-script allowlist (merged over {@link DEFAULT_ALLOW_BUILDS}). */
  readonly allowBuilds?: Record<string, boolean>;
}

/**
 * `pnpm-workspace.yaml`: the SOURCE OF TRUTH every other command reads back. Its
 * `packages` are sourced from `project.subprojects` via a thunk projen resolves at
 * synth (so member order/timing never matters), unioned with any globs added via
 * {@link addPackage}. Mutators ({@link addCatalog}, {@link allowBuild}) let mixins
 * and `.projenrc.ts` tweak it without a callback option.
 */
export class DBXToolsPNPMWorkspace extends YamlFile {
  private readonly catalog: Catalog;
  private readonly allowBuilds: Record<string, boolean>;
  private readonly packages: string[] = [];

  constructor(project: Project, options: DBXToolsPNPMWorkspaceOptions = {}) {
    super(project, "pnpm-workspace.yaml", {
      marker: true,
      readonly: true,
      obj: () => this.assemble(),
    });
    this.catalog = { ...options.catalog ?? {} };
    this.allowBuilds = {
      ...(options.allowBuilds ?? {})
    };
    this.packages = options.packages ?? [];
  }

  /** Add extra workspace member globs beyond the discovered subprojects. */
  public addPackage(...globs: string[]): void {
    this.packages.push(...globs);
  }

  /** Add or override a `catalog:` entry (dependency name -> version range). */
  public addCatalog(name: string, version: string): void {
    this.catalog[name] = version;
  }

  /** Allow (or disallow) a dependency's build scripts under pnpm v11. */
  public allowBuild(name: string, allowed = true): void {
    this.allowBuilds[name] = allowed;
  }

  private isEmpty() {
    if ([this.catalog, this.allowBuilds].every(o => Object.keys(o).length === 0)) {
      if ([this.packages].every(p => p.length === 0)) {
        return true;
      }
    }
    return false;
  }

  /** Assemble the final object (called by projen when it resolves the `obj` thunk). */
  private assemble(): PnpmWorkspaceConfig | null {
    if (this.project.parent) {
      if (this.isEmpty()) return null;
      else {
        throw new Error("DBXToolsPNPMWorkspace cannot be used in a subproject");
      }
    }
    const root = this.project.outdir;
    const members = this.project.subprojects
      .map((s) => toPosix(relative(root, s.outdir)))
      .filter(Boolean);
    const packages = [...new Set([...members, ...this.packages])].sort();
    const catalog = { ...DEFAULT_CATALOG, ...this.catalog };
    const allowBuilds = { ...DEFAULT_ALLOW_BUILDS, ...this.allowBuilds };
    return {
      packages,
      catalog,
      allowBuilds
    };
  }
}
