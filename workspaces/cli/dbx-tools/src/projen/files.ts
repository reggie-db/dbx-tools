/**
 * Generators for the repo-root config files projen owns.
 *
 * Each returns a projen file component written with a "generated" marker and
 * read-only permissions, so the checked-in `pnpm-workspace.yaml`, tsconfigs,
 * prettier config, `.vscode/*`, and the VS Code extension manifest all have a
 * single code source of truth in `.projenrc.ts`.
 */
import { relative } from "node:path";
import type { Project } from "projen";
import { JsonFile, TextFile, YamlFile, javascript } from "projen";
import type { Catalog } from "./configure";
import { toPosix } from "./workspace";

/**
 * Default pnpm v11 build-script allowlist: only `esbuild` (pulled in by tsx).
 * pnpm v11 gates build scripts behind `allowBuilds` and errors on a
 * non-interactive install until each is explicitly allowed.
 */
const DEFAULT_ALLOW_BUILDS: Record<string, boolean> = { esbuild: true };

/**
 * The `pnpm-workspace.yaml` object this engine writes. The three fields it always
 * manages are typed; the index signature lets {@link ModifyPnpmWorkspace} attach
 * any other pnpm-workspace setting (`overrides`, `packageExtensions`, ...).
 */
export interface PnpmWorkspaceConfig {
  /**
   * Workspace members (what pnpm links). Sourced from `project.subprojects` - every
   * `applyEnv` package (auto-discovered OR configured manually) is a subproject, so
   * it lands here automatically; nothing is hardcoded. A `pnpmWorkspace` hook may
   * still push extra globs/members.
   */
  packages: string[];
  /** The `catalog:` version registry every `catalog:` specifier resolves against. */
  catalog: Catalog;
  /** pnpm v11 build-script allowlist: dependency name -> allowed. */
  allowBuilds: Record<string, boolean>;
  [key: string]: unknown;
}

/** Last-chance hook to tweak the assembled `pnpm-workspace.yaml` object. */
export type ModifyPnpmWorkspace = (workspace: PnpmWorkspaceConfig) => void;

/**
 * `pnpm-workspace.yaml`: the SOURCE OF TRUTH every other command reads back. Its
 * `packages` list is sourced from `project.subprojects` at synth time (via a thunk
 * projen resolves late), so any subproject - discovered by `configureProjen` or
 * attached manually with `applyEnv` - is included with no hardcoded member list.
 * `pnpmWorkspace` receives the assembled object last, so a caller can add members,
 * catalog entries, or any other pnpm setting (`overrides`, `packageExtensions`, ...).
 */
export function pnpmWorkspace(
  project: Project,
  options: {
    readonly catalog: Catalog;
    readonly modify?: ModifyPnpmWorkspace;
  },
): void {
  const root = project.outdir;
  new YamlFile(project, "pnpm-workspace.yaml", {
    marker: true,
    readonly: true,
    // A thunk: projen resolves functions in a file `obj` at synth, by which point
    // every subproject is attached - so member order/timing doesn't matter.
    obj: () => {
      const packages = project.subprojects
        .map((s) => toPosix(relative(root, s.outdir)))
        .filter(Boolean)
        .sort();
      const workspace: PnpmWorkspaceConfig = {
        packages,
        catalog: options.catalog,
        allowBuilds: { ...DEFAULT_ALLOW_BUILDS },
      };
      options.modify?.(workspace);
      return workspace;
    },
  });
}

/**
 * Compiler options for the ROOT program only (`.projenrc.ts` + the engine as
 * seen from the root). Each package now owns its own projen-generated
 * `tsconfig.json` (scope `lib`/`jsx`/`types` overlaid on projen's defaults), so
 * this base no longer feeds packages — it just gives the projenrc/editor program
 * a sane ESM config. `lib` is set narrowly in `tsconfigRoot`.
 */
const BASE_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  moduleDetection: javascript.TypeScriptModuleDetection.FORCE,
  allowJs: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  isolatedModules: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
};

/** `tsconfig.base.json`: base for the root program (packages own their own now). */
export function tsconfigBase(project: Project): void {
  new JsonFile(project, "tsconfig.base.json", {
    marker: true,
    readonly: true,
    obj: { compilerOptions: BASE_COMPILER_OPTIONS },
  });
}

/**
 * `tsconfig.json`: the root program, covering just `.projenrc.ts`. The engine is
 * type-checked against its own hand-authored tsconfig; every package is checked
 * against its own projen-generated tsconfig by `dbxtools typecheck`, which is what
 * makes per-scope `lib` enforcement real.
 */
export function tsconfigRoot(project: Project): void {
  new JsonFile(project, "tsconfig.json", {
    marker: true,
    readonly: true,
    obj: {
      extends: "./tsconfig.base.json",
      compilerOptions: { lib: ["ESNext"], types: ["node"] } satisfies javascript.TypeScriptCompilerOptions,
      include: [".projenrc.ts"],
      exclude: ["node_modules", "**/dist", "**/node_modules"],
    },
  });
}

/** `prettier.config.js`: shared formatting rules. */
export function prettierConfig(project: Project): void {
  new TextFile(project, "prettier.config.js", {
    marker: true,
    readonly: true,
    lines: [
      '/** @type {import("prettier").Config} */',
      "export default {",
      "  printWidth: 88,",
      "  tabWidth: 2,",
      "  semi: true,",
      '  trailingComma: "all",',
      "};",
      "",
    ],
  });
}

/** `.prettierignore`: generated + build output the formatter should skip. */
export function prettierIgnore(project: Project): void {
  new TextFile(project, ".prettierignore", {
    marker: false,
    readonly: true,
    lines: [
      "node_modules",
      "dist",
      "**/dist/**",
      "pnpm-lock.yaml",
      "# generated barrels carry a do-not-edit header and are read-only",
      "**/src/**/index.ts",
      "",
    ],
  });
}

/**
 * `.vscode/tasks.json`: the `watch` task, set to run on folder open. projen has
 * no native tasks.json component, so a `JsonFile` is the idiomatic way to have
 * projen own `.vscode/`; `runOn: folderOpen` starts `projen watch` (which fans
 * out via concurrently to barrels + scaffolding + config re-synth) automatically
 * when the workspace opens - no extension needed.
 */
export function vscodeTasks(project: Project): void {
  new JsonFile(project, ".vscode/tasks.json", {
    marker: false,
    readonly: true,
    obj: {
      version: "2.0.0",
      tasks: [
        {
          label: "watch",
          detail: "projen watch - barrels + scaffold new packages + re-synth on config change",
          type: "shell",
          command: "pnpm exec projen watch",
          isBackground: true,
          problemMatcher: [],
          runOptions: { runOn: "folderOpen" },
          presentation: {
            reveal: "always",
            panel: "dedicated",
            group: "projen",
          },
        },
        {
          label: "synth",
          detail: "projen - synthesize all generated config",
          type: "shell",
          command: "pnpm exec projen",
          problemMatcher: [],
        },
      ],
    },
  });
}

/** `.vscode/settings.json`: use the workspace TypeScript and hide generated noise. */
export function vscodeSettings(project: Project): void {
  new JsonFile(project, ".vscode/settings.json", {
    marker: false,
    readonly: true,
    obj: {
      "typescript.tsdk": "node_modules/typescript/lib",
      "editor.formatOnSave": true,
      "editor.defaultFormatter": "esbenp.prettier-vscode",
      "files.watcherExclude": {
        "**/node_modules/**": true,
        "**/dist/**": true,
      },
    },
  });
}

/** `.vscode/extensions.json`: recommended editor extensions. */
export function vscodeExtensions(project: Project): void {
  new JsonFile(project, ".vscode/extensions.json", {
    marker: false,
    readonly: true,
    obj: { recommendations: ["esbenp.prettier-vscode"] },
  });
}

// No custom VS Code extension: the auto-run watcher is delivered by
// `.vscode/tasks.json` above (a projen-written file with `runOn: folderOpen`),
// which is projen's supported way to touch `.vscode/` - projen has no native
// tasks.json component, so a JsonFile is the idiomatic emitter.
