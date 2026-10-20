/**
 * Root `tsconfig.base.json` and `tsconfig.json` for the projenrc program.
 */
import { Component, type Project, javascript, typescript } from "projen";

/** Consumer overrides for the repository-root TypeScript program. */
export interface DBXToolsRootTsconfigOptions {
  readonly compilerOptions?: javascript.TypeScriptCompilerOptions;
  readonly include?: readonly string[];
}

/**
 * Compiler options for the ROOT program only (`.projenrc.ts` + the engine as
 * seen from the root). Each package owns its own projen-generated
 * `tsconfig.json` (scope `lib`/`jsx`/`types` overlaid on projen's defaults), so
 * this base does not feed packages - it just gives the projenrc/editor program
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
  /** Shared compiler floor inherited by the root program. */
  readonly base?: javascript.TypescriptConfig;

  /** Root program config inherited by the generated Projen config. */
  readonly config?: javascript.TypescriptConfig;

  constructor(scope: Project, options: DBXToolsRootTsconfigOptions = {}) {
    super(scope);

    if (scope instanceof typescript.TypeScriptProject) {
      return;
    }

    this.base = new javascript.TypescriptConfig(scope, {
      fileName: "tsconfig.base.json",
      compilerOptions: BASE_COMPILER_OPTIONS,
    });
    this.config = new javascript.TypescriptConfig(scope, {
      extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([this.base]),
      compilerOptions: {
        lib: ["ESNext"],
        types: ["node", "bun"],
        jsx: javascript.TypeScriptJsxMode.REACT_JSX,
        ...options.compilerOptions,
      },
      include: [".projenrc.ts", "test/**/*.ts", "test/**/*.tsx", ...(options.include ?? [])],
      exclude: ["node_modules", "**/dist", "**/node_modules"],
    });
  }
}
