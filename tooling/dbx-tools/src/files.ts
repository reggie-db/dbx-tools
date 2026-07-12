/**
 * Generators for the repo-root config files projen owns.
 *
 * Each returns a projen file component written with a "generated" marker and
 * read-only permissions, so the checked-in `pnpm-workspace.yaml`, tsconfigs,
 * prettier config, `.vscode/*`, and the VS Code extension manifest all have a
 * single code source of truth in `.projenrc.ts`.
 */
import type { Project } from "projen";
import { JsonFile, TextFile, YamlFile } from "projen";
import type { Deps } from "./scopes";

/**
 * `pnpm-workspace.yaml`: two-level package glob (`packages/<scope>/<name>`)
 * plus the VS Code extension, and the `catalog:` version registry every
 * package's `catalog:` specifier resolves against.
 */
export function pnpmWorkspace(project: Project, catalog: Deps): void {
  new YamlFile(project, "pnpm-workspace.yaml", {
    marker: true,
    readonly: true,
    obj: {
      packages: ["packages/*/*", "tooling/*"],
      catalog,
      // Approve the one dependency with a build script (esbuild, pulled in by
      // tsx). pnpm v11 gates build scripts behind `allowBuilds` and errors on a
      // non-interactive install until each is explicitly allowed here.
      allowBuilds: { esbuild: true },
    },
  });
}

/**
 * Compiler options shared by every program. `lib` is deliberately absent:
 * each package's profile sets it (see `projenrc/scopes.ts`) so nothing silently
 * inherits `DOM` from the `target` default. `allowImportingTsExtensions` + the
 * source-first `exports` let packages import each other's raw `.ts` with no
 * build step in the workspace.
 */
const BASE_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  moduleDetection: "force",
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
} as const;

/** `tsconfig.base.json`: the base every package tsconfig extends. */
export function tsconfigBase(project: Project): void {
  new JsonFile(project, "tsconfig.base.json", {
    marker: true,
    readonly: true,
    obj: { compilerOptions: BASE_COMPILER_OPTIONS },
  });
}

/**
 * `tsconfig.json`: the root program, covering just `.projenrc.ts`. The engine
 * lives in `packages/dev/projen-config` and is type-checked against its own
 * tsconfig; every other package is checked against its own profile tsconfig by
 * `pnpm run typecheck`, which is what makes per-scope `lib` enforcement real.
 */
export function tsconfigRoot(project: Project): void {
  new JsonFile(project, "tsconfig.json", {
    marker: true,
    readonly: true,
    obj: {
      extends: "./tsconfig.base.json",
      compilerOptions: { lib: ["ESNext"], types: ["node"] },
      include: ["projenrc.ts"],
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
 * projen own `.vscode/`; `runOn: folderOpen` starts `projen watch` (barrels +
 * scaffolding) automatically when the workspace opens - no extension needed.
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
          detail: "projen watch - regenerate barrels + scaffold new packages",
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
