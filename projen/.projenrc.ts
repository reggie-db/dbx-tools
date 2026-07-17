/**
 * Standalone projen config for the `@dbx-tools/projen` engine.
 *
 * This project is intentionally a VANILLA projen `TypeScriptProject` - it does
 * NOT build on the dbx-tools engine it ships (no self-hosting), so it can be
 * synthesized and edited without the bootstrap cycle that dogfooding created.
 * It lives inside the repo but is NOT a member of the root pnpm workspace; the
 * root links to it (see the repo `.pnpmfile.cjs` / `pnpm-workspace.yaml`).
 *
 * The engine imports three `@dbx-tools/*` utility packages at runtime
 * (`shared-core`, `node-core`, `node-path`). They are resolved to local source
 * under `../workspaces/` by this project's `.pnpmfile.cjs`, so they stay listed
 * here as plain (registry-shaped) dependencies.
 */
import { javascript, typescript } from "projen";
import { NodePackageManager } from "projen/lib/javascript";

const project = new typescript.TypeScriptProject({
  name: "@dbx-tools/projen",
  defaultReleaseBranch: "main",
  packageManager: NodePackageManager.PNPM,
  projenrcTs: true,
  typescriptVersion: "^5.9.3",
  // Consumed as TypeScript source via tsx (its `main`/`exports` point at .ts),
  // so there is no build/emit step to wire and no jest/eslint ceremony.
  sampleCode: false,
  jest: false,
  eslint: false,
  github: false,
  buildWorkflow: false,
  release: false,
  entrypoint: "index.ts",
  tsconfig: {
    compilerOptions: {
      rootDir: ".",
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2022",
      lib: ["ES2022"],
      skipLibCheck: true,
    },
    include: ["index.ts", "src/**/*.ts", "tasks/**/*.ts"],
  },
  deps: [
    "@clack/prompts@^1.7.0",
    "@dbx-tools/core@*",
    "@dbx-tools/path@*",
    "@dbx-tools/shared-core@*",
    "@typescript-eslint/typescript-estree@^8",
    "commander@^15.0.0",
    "consola@^3.4.2",
    "constructs@^10.6.0",
    "is-identifier@^1",
    "openapi-typescript@^7.13.0",
    "oxc-parser@^0.90.0",
    "p-memoize@^8.0.0",
    "projen@^0.101.6",
    "ts-to-zod@^5.1.0",
    "tsoa@^6.6.0",
    "tsx@^4.23.0",
    "yaml@^2.9.0",
  ],
  devDeps: ["@types/node@^24.6.0"],
});

// This package is consumed as TS source; publish the source subpaths, not a
// compiled `lib/`.
project.package.addField("type", "module");
project.package.addField("main", "index.ts");
project.package.addField("types", "index.ts");
project.package.addField("exports", {
  ".": "./index.ts",
  "./engine-root": "./src/engine-root.ts",
  "./package.json": "./package.json",
});

// Track the hand-authored files projen's default dotfile ignore would drop:
// the pnpm workspace root marker (keeps this project isolated from the parent
// workspace) and the util-dep link hook.
project.gitignore.include(".pnpmfile.cjs", "pnpm-workspace.yaml");

project.synth();
