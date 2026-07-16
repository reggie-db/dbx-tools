/**
 * `pnpm-workspace.yaml` as a first-class projen file component.
 *
 * `DBXToolsPNPMWorkspace` extends projen's `YamlFile` and is exposed as the
 * `pnpmWorkspace` field on a tree ROOT (only a root emits the file, so on a child
 * package the field is `undefined` - like projen's optional `project.eslint`). A
 * mixin or a consumer's `.projenrc.ts` tweaks it via that field
 * (`project.pnpmWorkspace?.addCatalog(...)`, `.allowBuild(...)`, `.addPackages(...)`,
 * or `file.addOverride(...)` for any other pnpm setting). Its `packages` list is NOT
 * hardcoded: it is recomputed from
 * `project.subprojects` at synth time (projen resolves the `obj` thunk late, by
 * which point every subproject is attached), so any package - discovered by the
 * root's scan or attached manually - lands here automatically.
 *
 * Replaces the old `files.pnpmWorkspace()` free function + `ModifyPnpmWorkspace`
 * option (both removed): mutation now goes through the typed instance methods.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { find } from "@dbx-tools/shared-file-scan";
import { type Project, YamlFile } from "projen";
import YAML from "yaml";
import { makeReadonly } from "./generated";
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

const FILE_PATH_PNPM_WORKSPACE = "pnpm-workspace.yaml";
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
 * {@link addPackages}. Mutators ({@link addCatalog}, {@link allowBuild}) let mixins
 * and `.projenrc.ts` tweak it without a callback option.
 */
export class DBXToolsPNPMWorkspace extends YamlFile {
  private readonly catalogOverrides: Catalog = {};
  private readonly allowBuildOverrides: Record<string, boolean> = {};
  private readonly extraPackages = new Set<string>();

  constructor(project: Project, options: DBXToolsPNPMWorkspaceOptions = {}) {
    super(project, FILE_PATH_PNPM_WORKSPACE, {
      marker: true,
      readonly: true,
      obj: () => this.assemble(),
    });

    options.packages?.forEach((glob) => this.addPackages(glob));
    if (options.catalog) {
      Object.entries(options.catalog).forEach(([name, version]) => this.addCatalog(name, version));
    }
    if (options.allowBuilds) {
      Object.entries(options.allowBuilds).forEach(([name, allowed]) =>
        this.allowBuild(name, allowed),
      );
    }
  }

  /** Add extra workspace member globs beyond the discovered subprojects. */
  public addPackages(...globs: string[]): void {
    globs.forEach((glob) => {
      this.extraPackages.add(glob);
      this.addToArray("packages", glob);
    });
  }

  /** Add or override a `catalog:` entry (dependency name -> version range). */
  public addCatalog(name: string, version: string): void {
    this.catalogOverrides[name] = version;
    this.addOverride(`catalog.${name}`, version);
  }

  /** Allow (or disallow) a dependency's build scripts under pnpm v11. */
  public allowBuild(name: string, allowed = true): void {
    this.allowBuildOverrides[name] = allowed;
    this.addOverride(`allowBuilds.${name}`, allowed);
  }

  private assemble(): Record<string, unknown> {
    const outdir = this.project.outdir;
    const members = this.project.subprojects
      .map((s) => toPosix(relative(outdir, s.outdir)))
      .filter(Boolean);
    return {
      packages: [...new Set([...members, ...this.extraPackages])].sort(),
      catalog: { ...DEFAULT_CATALOG, ...this.catalogOverrides },
      allowBuilds: { ...DEFAULT_ALLOW_BUILDS, ...this.allowBuildOverrides },
    };
  }

  /**
   * Generates a bootstrap file on disk before subprojects synthesize.
   * This ensures pnpm can resolve "catalog:" during subproject auto-installs.
   */
  override preSynthesize(): void {
    super.preSynthesize();
    const obj = this.assemble();

    const header =
      [
        "@yaml-language-server $schema=https://json.schemastore.org/pnpm-workspace.json",
        "Temporary pnpm-workspace.yaml generated by projen during preSynthesis",
      ]
        .map((line) => `# ${line}`)
        .join("\n") + "\n";

    const yamlContent = header + YAML.stringify(obj);

    const filePath = join(this.project.outdir, FILE_PATH_PNPM_WORKSPACE);

    mkdirSync(dirname(filePath), { recursive: true });

    if (existsSync(filePath)) {
      rmSync(filePath);
    }

    writeFileSync(filePath, yamlContent, "utf8");
    makeReadonly(filePath);
  }
}

if (import.meta.main) {
  const startedAt = Date.now();
  const extensions = ["ts", "tsx", "js", "jsx"];
  const files = find.findFiles(`**/*.{${extensions.join(",")}}`, {
    ignore: ["**/index.ts", `**/_*.{${extensions.join(",")}}`],
  });
  let count = 0;
  for (const file of files) {
    count++;
    console.log(file);
  }
  const elapsed = Date.now() - startedAt;
  console.log(`Found ${count} files in ${elapsed}ms`);
}
