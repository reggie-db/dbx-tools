/**
 * Generators for the repo-root config files projen owns.
 *
 * Each returns a projen file component written with a "generated" marker and
 * read-only permissions, so the checked-in `pnpm-workspace.yaml`, tsconfigs,
 * prettier config, `.vscode/*`, and the VS Code extension manifest all have a
 * single code source of truth in `.projenrc.ts`.
 */
import type { Project } from "projen";
import { JsonFile, TextFile, javascript } from "projen";

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
 * `.vscode/tasks.json`: the `sync` task, set to run on folder open. projen has no
 * native tasks.json component, so a `JsonFile` is the idiomatic way to have projen
 * own `.vscode/`; `runOn: folderOpen` starts `projen sync --watch` (the single
 * `dbxtools watch` loop: re-synth on `.projenrc.ts`/package changes, barrels on
 * source edits) automatically when the workspace opens - no extension needed.
 */
export function vscodeTasks(project: Project): void {
  new JsonFile(project, ".vscode/tasks.json", {
    marker: false,
    readonly: true,
    obj: {
      version: "2.0.0",
      tasks: [
        {
          label: "sync",
          detail: "projen sync --watch - dbxtools watch (re-synth when needed + barrels)",
          type: "shell",
          command: "pnpm exec projen sync --watch",
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
