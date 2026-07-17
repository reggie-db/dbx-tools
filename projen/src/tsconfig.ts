/**
 * Root `tsconfig.base.json` and `tsconfig.json` for the projenrc program.
 */
import { Component, JsonFile, type Project, javascript } from "projen";

/**
 * Compiler options for the ROOT program only (`.projenrc.ts` + the engine as
 * seen from the root). Each package now owns its own projen-generated
 * `tsconfig.json` (scope `lib`/`jsx`/`types` overlaid on projen's defaults), so
 * this base no longer feeds packages - it just gives the projenrc/editor program
 * a sane ESM config. `lib` is set narrowly in the root `tsconfig.json`.
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

/**
 * Emits `tsconfig.base.json` and `tsconfig.json` for the monorepo root program.
 * Packages type-check against their own projen-generated tsconfigs via `compile`.
 */
export class DBXToolsRootTsconfig extends Component {
  constructor(scope: Project) {
    super(scope);

    new JsonFile(scope, "tsconfig.base.json", {
      marker: true,
      readonly: true,
      obj: { compilerOptions: BASE_COMPILER_OPTIONS },
    });

    new JsonFile(scope, "tsconfig.json", {
      marker: true,
      readonly: true,
      obj: {
        extends: "./tsconfig.base.json",
        compilerOptions: {
          lib: ["ESNext"],
          types: ["node"],
        } satisfies javascript.TypeScriptCompilerOptions,
        include: [".projenrc.ts"],
        exclude: ["node_modules", "**/dist", "**/node_modules"],
      },
    });
  }
}
