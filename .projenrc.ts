/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `workspacePackageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `<tag>/<name>/src` folder under `workspaces/`
 * (real content) and `example-workspaces/` (the seed examples this repo ships,
 * kept separate). The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `workspaces/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * Per-package tweaks are MIXINS applied with `project.with(...)` (constructs-
 * native, across the subtree; the built-in tag mixins already ran during
 * construction). `synth()` is called manually because this repo adds a thin `dbxtools`
 * root task first (see below); a normal consumer constructs, `with(...)`s, synths.
 */
import path, { basename } from "node:path";
import { packageMixin } from "./workspaces/shared/projen/src/mixins";
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
} from "./workspaces/shared/projen/src/project";

const SCOPE = "dbx-tools";
const EXAMPLE_WORKSPACES_ROOT = "example-workspaces";

const project = new DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  // `workspaces/` is the default; `example-workspaces/` is this repo's own addition
  // so seed content stays visually separate from real content added later.
  workspacePackageRoots: ["workspaces", EXAMPLE_WORKSPACES_ROOT],
  github: true,
  buildWorkflow: true,
  release: true,
  releaseToNpm: true,
  workflowPackageCache: true,
  depsUpgrade: false,
});

project.pnpmWorkspace?.allowBuild("unrs-resolver");
project.pnpmWorkspace?.addOverride("overrides.glob", "^13.0.0");
// Per-package tweaks are user MIXINS applied across the subtree with the
// constructs-native `project.with(...)` - it runs each mixin over the current tree
// (captured at call time), after the built-in tag mixins the root already applied
// during construction. Each dispatches on the STABLE folder identity: the
// package's resolved tags + its folder name (not the derived npm name).
project.with(
  packageMixin(
    (p) => {
      const outdirRelativeToRoot = path.relative(project.root.outdir, p.outdir);
      const exampleWorkspace =
        outdirRelativeToRoot == EXAMPLE_WORKSPACES_ROOT ||
        outdirRelativeToRoot.startsWith(EXAMPLE_WORKSPACES_ROOT + "/");
      return exampleWorkspace;
    },
    (p) => p.package.addField("private", true),
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("shared") && basename(p.outdir) === "projen",
    (p) => {
      p.dbxToolsConfig.addTags("node");
      p.addDeps(
        "projen",
        "constructs",
        "barrelsby",
        "openapi-typescript",
        "tsoa",
        "yaml",
        "tsx",
        "picomatch",
        "p-memoize",
        "commander",
        "@clack/prompts",
        "consola",
        "pnpm",
        "@dbx-tools/shared-file-scan@workspace:*",
        "@dbx-tools/shared-core@workspace:*",
      );
      p.addDevDeps("@types/picomatch@^4.0.3");
      p.package.addField("exports", {
        ".": "./index.ts",
        "./log": "./src/log.ts",
        "./pnpm": "./src/pnpm.ts",
        "./engine-root": "./src/engine-root.ts",
        "./package.json": "./package.json",
      });
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
        p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
        p.tsconfig?.addInclude("tasks/**/*.ts");
      }
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("shared") && basename(p.outdir) === "file-scan",
    (p) => {
      p.addDeps("chokidar", "glob", "minimatch", "@dbx-tools/shared-core@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("ui") && basename(p.outdir) === "app",
    (p) => {
      p.addDeps("@dbx-tools/shared-core@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("server") && basename(p.outdir) === "api",
    (p) => {
      // express + dev/start come from the built-in `server` tag mixin (tags.ts).
      p.addDeps("@dbx-tools/shared-core@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "main",
    (p) => {
      p.package.addBin({ "pw-demo": "./src/cli.ts" });
      p.addDeps("@dbx-tools/shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "dbx-tools",
    (p) => {
      p.package.addField("name", SCOPE);
      p.dbxToolsConfig.lockPackageJson = false;
      // The engine, dogfooded through the normal `cli` tag. Override the
      // auto-derived name (`@dbx-tools/cli-dbx-tools`) to the clean `@dbx-tools/cli`.
      p.package.addField("publishConfig", {
        access: "public",
        provenance: true,
      });
      p.package.addBin({ dbxtools: "./bin/dbxtools.ts" });
      p.package.addField("exports", {
        ".": "./index.ts",
        "./log": "./src/log.ts",
        "./bin": "./src/bin.ts",
        "./package.json": "./package.json",
      });
      p.addDeps(
        "@dbx-tools/shared-projen@workspace:*",
        "consola",
        "pnpm",
      );
      if (p instanceof DBXToolsTypeScriptProject) {
        // ES2022 stdlib (e.g. Object.hasOwn in the logger) - the `cli` tag default is
        // ES2020. Also cover the root `index.ts` barrel and the `bin/` CLI, which the
        // tag's default `src/**/*.ts` include doesn't reach - widening `rootDir` to
        // the package root avoids TS6059 ("not under rootDir") for both.
        p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
        p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
        p.tsconfig?.addInclude("bin/**/*.ts");
      }
    },
  ),
);

// The engine lives in-tree as an auto-discovered workspace package, so its `dbxtools`
// bin is not linked at the root. Register a thin projen task that forwards argv to
// projen (the bin itself has no subcommands). A repo consuming `@dbx-tools/cli` from
// npm uses the installed package's linked bin instead.
project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
