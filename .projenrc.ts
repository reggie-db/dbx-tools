/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `workspacePackageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `<tag>/<name>/src` folder under `workspaces/`
 * (real content) and `example-workspaces/` (the seed examples this repo ships,
 * kept separate). The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `workspaces/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * Example-workspace mixins live in `.example.projenrc.ts`.
 *
 * Per-package tweaks are MIXINS applied with `project.with(...)` (constructs-
 * native, across the subtree; the built-in tag mixins already ran during
 * construction). `synth()` is called manually because this repo adds a thin `dbxtools`
 * root task first (see below); a normal consumer constructs, `with(...)`s, synths.
 */
import { basename } from "node:path";
import { JsonFile } from "projen";
import { applyExampleWorkspaces } from "./.example.projenrc";
import { fileMixin, packageMixin } from "./workspaces/shared/projen/src/mixins";
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
} from "./workspaces/shared/projen/src/project";

const SCOPE = "dbx-tools";

const project = new DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  workspacePackageRoots: ["workspaces", "example-workspaces"],
  github: true,
  buildWorkflow: true,
  release: true,
  releaseToNpm: true,
  workflowPackageCache: true,
  depsUpgrade: false,
});

project.pnpmWorkspace?.allowBuild("unrs-resolver");
project.pnpmWorkspace?.addOverride("overrides.glob", "^13.0.0");

project.with(
  fileMixin((file) => {
    if (file.path === "tsconfig.json" && file.project === project) {
      (file as JsonFile).addOverride("include", [".projenrc.ts", ".example.projenrc.ts"]);
    }
  }),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("shared") && basename(p.outdir) === "core",
    (p) => {
      p.dbxToolsConfig.addTags("node");
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.types", ["node"]);
      }
    },
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
    (p) => p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "dbx-tools",
    (p) => {
      p.package.addField("name", SCOPE);
      p.dbxToolsConfig.lockPackageJson = false;
      p.package.addField("publishConfig", {
        access: "public",
        provenance: true,
      });
      p.package.addBin({ dbxtools: "./bin/dbxtools.ts" });
      p.package.addField("exports", {
        ".": "./index.ts",
        "./pnpm": "./src/pnpm.ts",
        "./package.json": "./package.json",
      });
      p.addDeps("@dbx-tools/shared-core@workspace:*", "pnpm");
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
        p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
        p.tsconfig?.addInclude("bin/**/*.ts");
      }
    },
  ),
);

applyExampleWorkspaces(project);

project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
