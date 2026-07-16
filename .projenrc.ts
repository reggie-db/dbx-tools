/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `workspacePackageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `src`-bearing package folder at any depth under
 * `workspaces/` (real content) and `example-workspaces/` (the seed examples this repo
 * ships, kept separate). The engine itself is dogfooded as a normal auto-discovered `cli`
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
import path from "node:path";
import { JsonFile, Project } from "projen";
import { applyExampleWorkspaces } from "./.example.projenrc";
import { mixin } from "./workspaces/shared/projen/src/mixin";
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
  isDBXToolsPackage,
  packageIdentifier,
} from "./workspaces/shared/projen/src/package";
import { predicate } from "./workspaces/shared/core/index";

const SCOPE = "dbx-tools";

function isWorkspacesPackage(p: { root: { outdir: string }; outdir: string }): boolean {
  const rel = path.relative(p.root.outdir, p.outdir);
  return rel === "workspaces" || rel.startsWith("workspaces/");
}

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
  mixin(
    (file): file is JsonFile =>
      file instanceof JsonFile &&
      file.path === "tsconfig.json" &&
      file.project === project,
    (file) => {
      file.addOverride("include", [".projenrc.ts", ".example.projenrc.ts"]);
    },
  ),
  mixin(
    predicate
      .toPredicate(isDBXToolsPackage)
      .and(isWorkspacesPackage)
      .and((p) => p.dbxToolsConfig.tags.includes("shared"))
      .and((p) => p.packageIdentifier.name === "shared-core"),
    (p) => {
      p.dbxToolsConfig.addTags("node");
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.types", ["node"]);
      }
    },
  ),
  mixin(
    predicate
      .toPredicate(isDBXToolsPackage)
      .and(isWorkspacesPackage)
      .and((p) => p.dbxToolsConfig.tags.includes("shared"))
      .and((p) => p.packageIdentifier.name === "shared-projen"),
    (p) => {
      p.package.addField("name", packageIdentifier(p.root).withName("projen").packageName);
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
        "concurrently",
        "consola",
        "@typescript-eslint/typescript-estree@^8",
        "typescript@catalog:",
        "is-identifier@^1",
        "@dbx-tools/shared-file-scan@workspace:*",
        "@dbx-tools/shared-core@workspace:*",
      );
      p.addDevDeps("@types/picomatch@^4.0.3");
      p.package.addField("exports", {
        ".": "./index.ts",
        "./log": "./src/log.ts",
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
  mixin(
    predicate
      .toPredicate(isDBXToolsPackage)
      .and(isWorkspacesPackage)
      .and((p) => p.dbxToolsConfig.tags.includes("shared"))
      .and((p) => p.packageIdentifier.name === "shared-file-scan"),
    (p) => {
      p.addDeps("chokidar", "glob", "minimatch", "@dbx-tools/shared-core@workspace:*");
    },
  ),
  mixin(
    predicate
      .toPredicate(isDBXToolsPackage)
      .and(isWorkspacesPackage)
      .and((p) => p.dbxToolsConfig.tags.includes("cli"))
      .and((p) => p.packageIdentifier.name === "cli-dbx-tools"),
    (p) => {
      p.package.addField("name", SCOPE);
      p.package.file.readonly = false;
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
