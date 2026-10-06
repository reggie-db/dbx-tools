/**
 * Self-synthesizing projen config for the `@dbx-tools/projen` engine.
 *
 * This project is intentionally a VANILLA projen `TypeScriptProject` - it does
 * NOT build on the dbx-tools engine it ships (no self-hosting), so it can be
 * synthesized and edited without the bootstrap cycle dogfooding would create.
 * It lives inside the repo AND is a member of the single bun workspace (the
 * root lists `projen` via `extraWorkspaceMembers`, since this project synthesizes
 * ITSELF and is not a root subproject).
 *
 * The engine imports three `@dbx-tools/*` utility packages at runtime
 * (`shared-core`, `node-core`, `node-path`). As workspace siblings they are
 * declared `workspace:^` and bun links them from local source.
 */
import { fileURLToPath } from "node:url";
import { DependencyType, javascript, typescript } from "projen";
import { NodePackageManager } from "projen/lib/javascript";
import { PROJEN_VERSION } from "./src/projen-version.ts";
import { readWorkspaceVersion } from "./src/workspace-version.ts";

const PACKAGE_VERSION = readWorkspaceVersion(fileURLToPath(new URL("..", import.meta.url)));

const project = new typescript.TypeScriptProject({
  name: "@dbx-tools/projen",
  defaultReleaseBranch: "main",
  // A member of the single bun workspace. No nested `pnpm-workspace.yaml` marker is
  // needed - bun resolves the `workspace:^` sibling deps from the root install.
  packageManager: NodePackageManager.BUN,
  projenVersion: PROJEN_VERSION,
  // The projenrc runner is reset to `bun` below (bun runs `.ts` directly). This
  // package is `type: module` and `.projenrc.ts` does a directory import
  // (`projen/lib/javascript`); bun resolves it fine.
  projenrcTs: false,
  typescriptVersion: "^5.9.3",
  // Consumed as TypeScript source via bun (its `main`/`exports` point at .ts),
  // so there is no build/emit step to wire and no jest/eslint ceremony.
  sampleCode: false,
  jest: false,
  eslint: false,
  // No GitHub component (a workflow under `projen/.github/` would never run -
  // GitHub Actions only executes workflows from the REPO-ROOT `.github/`).
  // The root release workflow publishes this workspace member.
  github: false,
  buildWorkflow: false,
  release: false,
  entrypoint: "index.ts",
  entrypointTypes: "index.ts",
  repository: "git+https://github.com/reggie-db/dbx-tools.git",
  repositoryDirectory: "projen",
  tsconfig: {
    compilerOptions: {
      rootDir: ".",
      module: "ESNext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
      target: "ES2022",
      lib: ["ES2022"],
      skipLibCheck: true,
      // This package ships SOURCE (run directly by Bun), so it never emits - but its
      // own modules carry the same explicit `.ts` specifiers the packages use,
      // which the compiler only accepts with this on.
      noEmit: true,
      allowImportingTsExtensions: true,
    },
    include: ["index.ts", "src/**/*.ts", "tasks/**/*.ts"],
  },
  deps: [
    "@clack/prompts@^1.7.0",
    // `workspace:^` now that `projen/` is a MEMBER of the single bun workspace:
    // bun links these three from local source and rewrites them to the real
    // published range at publish time (root synthesis supplies that version),
    // so the engine still cannot resolve an older sibling than it was built with.
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/path@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "commander@^15.0.0",
    // `tasks/sync.ts` imports this to fan the watchers out. It resolved here only
    // because the repo root happens to depend on it; a consumer install has no
    // such luck and `sync --watch` dies on a missing module.
    "concurrently@^10.0.3",
    "constructs@^10.6.0",
    "is-identifier@^1",
    "node-stdlib-browser@^1.3.1",
    "oxc-parser@^0.90.0",
    "semver@^7.7.3",
    "smol-toml@1.8.0",
    "ts-to-zod@^5.1.0",
    "typescript@^5.9.3",
    "yaml@^2.9.0",
    "zod@^4.3.6",
  ],
  peerDeps: [`projen@${PROJEN_VERSION}`],
  devDeps: ["@types/node@^24.6.0", "@types/semver@^7.7.1"],
});
new javascript.TypescriptConfig(project, {
  fileName: "shims/python-node/tsconfig.json",
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
    lib: ["ES2022", "DOM"],
    types: ["node"],
    noEmit: true,
    skipLibCheck: true,
    strict: false,
  },
  include: ["*.ts"],
});
// PythonMonkey shims are engine source. The package owner keeps the complete
// tree trackable so consuming repositories need no root ignore exceptions.
project.gitignore.include("/shims/python-node/**");
project.deps.removeDependency("constructs", DependencyType.BUILD);
project.deps.removeDependency("typescript", DependencyType.BUILD);

// Preserve the version read from the shared workspace VERSION. The TypeScriptProject
// constructor's `version` option is ignored when `release: false`, so use the
// native package version API.
project.package.addVersion(PACKAGE_VERSION);

// This package is consumed as TS source; publish the source subpaths, not a
// compiled `lib/`.
project.package.addField("type", "module");
project.package.addField("exports", {
  ".": "./index.ts",
  "./release-packaging": "./tasks/lib/publish-npm.ts",
  "./package.json": "./package.json",
});

// This package ships SOURCE (its `main`/`exports`/task scripts all point at
// `.ts`, run directly by Bun), so the published tarball must contain the TypeScript, not
// the compiled `lib/`. A `files` allowlist is the idiomatic, self-contained way
// to say exactly that - it takes precedence over projen's generated `.npmignore`
// (which excludes `/src/`), so `index.ts` (re-exports `./src/*`), the `src/`
// modules, and the `tasks/` scripts a consumer runs as `bun <engine>/tasks/*.ts`
// are all present. PythonMonkey generation also resolves its build-time
// compatibility shims from the installed engine package. Without this allowlist
// the public entrypoint or binding generator imports missing files.
project.package.addField("files", ["index.ts", "src", "tasks", "shims/python-node"]);

// Keep `.projenrc.ts`/`projenrc/` out of the published tarball.
project.npmignore?.exclude(".projenrc.ts", "projenrc/");

const projenrc = new typescript.ProjenrcTs(project, {
  runner: typescript.TypeScriptRunner.nodejs(),
});
if (project.tsconfig) projenrc.tsconfig.addExtends(project.tsconfig);
projenrc.tsconfig.removeInclude("**/*.ts");
project.defaultTask?.reset("bun .projenrc.ts");
project.tasks.tryFind("install:ci")?.reset("bun install");
project.testTask.exec("bun test test");
project.synth();
