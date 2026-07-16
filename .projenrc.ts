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
 * Per-package tweaks are MIXINS applied with `project.mixin(...)` (constructs-
 * native, across the subtree; the built-in tag mixins already ran during
 * construction). `synth()` is called manually because this repo adds a thin `dbxtools`
 * root task first (see below); a normal consumer constructs, `with(...)`s, synths.
 */
import { JsonFile, Project } from "projen";
import { applyExampleWorkspaces } from "./.example.projenrc";
import { mixin, project as projectApi, projectPredicate } from "@dbx-tools/projen";

const SCOPE = "dbx-tools";

const workspaces = projectPredicate.hasPath("workspaces");

const project = new projectApi.DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  workspacePackageRoots: ["workspaces", "example-workspaces"],
  syncResynthPaths: [".example.projenrc.ts"],
  github: true,
  buildWorkflow: true,
  release: true,
  releaseToNpm: true,
  workflowPackageCache: true,
  depsUpgrade: false,
  devDeps: ["concurrently", "@dbx-tools/shared-core@workspace:*", "@dbx-tools/projen@workspace:*"],
});
project.pnpmWorkspace?.allowBuild("@databricks/appkit-ui");
project.pnpmWorkspace?.allowBuild("@databricks/appkit");
project.pnpmWorkspace?.allowBuild("@google/genai", true);
project.pnpmWorkspace?.allowBuild("protobufjs", true);
project.pnpmWorkspace?.allowBuild("agent-browser", false);
project.pnpmWorkspace?.allowBuild("bufferutil", false);
project.pnpmWorkspace?.allowBuild("edgedriver", false);
project.pnpmWorkspace?.allowBuild("geckodriver", false);
project.pnpmWorkspace?.allowBuild("onnxruntime-node", false);

project.pnpmWorkspace?.addOverride("overrides.glob", "^13.0.0");
console.log("shared", project.name);
project.with(
  mixin.mixin(
    (file): file is JsonFile =>
      file instanceof JsonFile &&
      file.path === "tsconfig.json" &&
      file.project === project,
    (file) => {
      file.addOverride("include", [".projenrc.ts", ".example.projenrc.ts"]);
    },
  ),
  mixin.mixin(workspaces.and(projectPredicate.hasName("@dbx-tools/shared-core").negate()).and(projectPredicate.hasTag("shared")), (p) => {
    p.addDeps("@dbx-tools/shared-core@workspace:*");
  }),
  mixin.mixin(workspaces.and(projectPredicate.hasName("*/shared-core")).and(projectPredicate.hasTag("shared")), (p) => {
    p.dbxToolsConfig.tags.push("node");
    if (p instanceof projectApi.DBXToolsTypeScriptProject) {
      p.tsconfig?.file.addOverride("compilerOptions.types", ["node"]);
    }
  }),
  mixin.mixin(workspaces.and(projectPredicate.hasName("*/shared-file-scan")).and(projectPredicate.hasTag("shared")), (p) => {
    // Pin explicit ranges: bare names resolve against the local registry, which can
    // return stale majors (e.g. minimatch@3 lacks the `{ Minimatch }` ESM export the
    // code imports, chokidar@1 predates the v4 API).
    p.addDeps(
      "@dbx-tools/shared-core@workspace:*",
      "glob@^10.5.0",
      "chokidar@^4.0.3",
      "minimatch@^10.2.5",
    );
  }),
  mixin.mixin(workspaces.and(projectPredicate.hasName("*/shared-projen")).and(projectPredicate.hasTag("shared")), (p) => {
    p.package.addField("name", projectApi.identifier(p.root).withName("projen").packageName);
    p.dbxToolsConfig.tags.push("node");
    p.addDeps(
      "projen",
      "constructs",
      "barrelsby",
      "openapi-typescript",
      "tsoa",
      "yaml",
      "tsx",
      "p-memoize",
      "commander",
      "@clack/prompts",
      "consola",
      "@typescript-eslint/typescript-estree@^8",
      "typescript@catalog:",
      "is-identifier@^1",
      "@dbx-tools/shared-file-scan@workspace:*",
      "@dbx-tools/shared-core@workspace:*",
    );
    p.package.addField("exports", {
      ".": "./index.ts",
      "./log": "./src/log.ts",
      "./engine-root": "./src/engine-root.ts",
      "./package.json": "./package.json",
    });
    if (p instanceof projectApi.DBXToolsTypeScriptProject) {
      p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
      p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
      p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
      p.tsconfig?.addInclude("index.ts");
      p.tsconfig?.addInclude("tasks/**/*.ts");
    }
  }),
  mixin.mixin(workspaces.and(projectPredicate.hasName("*/cli-dbx-tools")).and(projectPredicate.hasTag("cli")), (p) => {
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
    if (p instanceof projectApi.DBXToolsTypeScriptProject) {
      p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
      p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
      p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
      p.tsconfig?.addInclude("index.ts");
      p.tsconfig?.addInclude("bin/**/*.ts");
    }
  })
);



applyExampleWorkspaces(project);

project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
