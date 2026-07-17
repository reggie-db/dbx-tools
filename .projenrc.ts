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

/** Only real content under `workspaces/` (not the `example-workspaces/` seeds). */
const workspaces = projectPredicate.hasPath("workspaces");

/** A workspace package selected by npm-name glob + a required tag. */
const pkg = (name: string, tag: string) =>
  workspaces.and(projectPredicate.hasName(name)).and(projectPredicate.hasTag(tag));

/**
 * Bump a package that compiles files outside `src/` (its root `index.ts`, a `bin/`
 * or `tasks/` tree) to an ES2022, root-relative tsconfig and add each extra include.
 * The tag defaults (`src/**` only, older lib/target) don't reach that code.
 */
function applyRootDirTsconfig(p: Project, ...includes: string[]): void {
  if (!(p instanceof projectApi.DBXToolsTypeScriptProject)) return;
  p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
  p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
  p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
  for (const include of includes) p.tsconfig?.addInclude(include);
}

// ---------------------------------------------------------------------------
// Root construction
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// pnpm workspace: build-script allowances + version overrides
// ---------------------------------------------------------------------------
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


// ---------------------------------------------------------------------------
// Per-package mixins
// ---------------------------------------------------------------------------
project.with(
  // Root's own tsconfig: compile the projenrc entrypoints alongside the packages.
  mixin.mixin(
    (file): file is JsonFile =>
      file instanceof JsonFile &&
      file.path === "tsconfig.json" &&
      file.project === project,
    (file) => {
      file.addOverride("include", [".projenrc.ts", ".example.projenrc.ts"]);
    },
  ),

  // Every shared workspace package (except shared-core itself) depends on shared-core.
  // This is why the per-package mixins below no longer add it explicitly.
  mixin.mixin(
    workspaces
      .and(projectPredicate.hasName("@dbx-tools/shared-core").negate())
      .and(projectPredicate.hasTag("shared")),
    (p) => {
      p.addDeps("@dbx-tools/shared-core@workspace:*");
    },
  ),

  // shared-core: the browser-safe base every package builds on. consola is an
  // OPTIONAL peer: the `log` module lazy-imports it and degrades to a console
  // fallback when it's absent, so consumers may leave it uninstalled. Version
  // tracks the hardcoded DEFAULT_CATALOG entry.
  mixin.mixin(pkg("*/shared-core", "shared"), (p) => {
    p.addPeerDeps("consola@catalog:");
    p.package.addField("peerDependenciesMeta", { consola: { optional: true } });
    // Present for local dev/typecheck; consumers opt in via the catalog.
    p.addDevDeps("consola@catalog:");
  }),

  // node-core: the Node-only half of the shared runtime (exec + project). Lives
  // under workspaces/node/, so the `node` tag auto-applies (node types + ES2022
  // lib, no DOM). shared-core stays browser-safe; anything needing child_process
  // / fs / process depends on node-core instead.
  mixin.mixin(pkg("*/node-core", "node"), (p) => {
    p.addDeps("@dbx-tools/shared-core@workspace:*");
  }),

  // node-appkit: the base for Node-side AppKit + experimental-SDK helpers.
  // Houses the SDK Context/AbortSignal adapter so the browser-safe shared-core
  // stays SDK-free. The Databricks SDK is a runtime dep here.
  mixin.mixin(pkg("*/node-appkit", "node"), (p) => {
    p.addDeps("@dbx-tools/shared-core@workspace:*", "@databricks/sdk-experimental@catalog:");
  }),

  // node-genie: the server-side Genie driver (live chat + space metadata).
  // Consumes the browser-safe shared-genie contracts, node-appkit's SDK glue,
  // and the SDK at runtime. AppKit is an OPTIONAL peer - the client resolver
  // lazy-imports it and falls back to env-var auth when it's absent.
  mixin.mixin(pkg("*/node-genie", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-core@workspace:*",
      "@dbx-tools/shared-genie@workspace:*",
      "@dbx-tools/node-appkit@workspace:*",
      "@databricks/sdk-experimental@catalog:",
    );
    p.addPeerDeps("@databricks/appkit@catalog:");
    p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
    p.addDevDeps("@databricks/appkit@catalog:");
  }),

  // node-file-scan: filesystem glob/watch package. It shells out (node-core
  // exec) and uses chokidar/glob, so it lives under workspaces/node/ (the `node`
  // tag auto-applies). Pin explicit ranges: bare names resolve against the local
  // registry, which can return stale majors (e.g. minimatch@3 lacks the
  // `{ Minimatch }` ESM export the code imports, chokidar@1 predates the v4 API).
  mixin.mixin(pkg("*/node-file-scan", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/node-core@workspace:*",
      "glob@^10.5.0",
      "chokidar@^4.0.3",
      "minimatch@^10.2.5",
    );
  }),

  // shared-model: browser-safe zod wire contracts + pure endpoint classifier.
  mixin.mixin(pkg("*/shared-model", "shared"), (p) => {
    p.addDeps("zod@catalog:");
  }),

  // shared-sdk-model: zod schemas generated by `dbxtools codegen` from the
  // Databricks SDK .d.ts. The generated modules only need zod at runtime; the
  // SDK is a devDep (codegen reads its declarations). The `codegen.inputs`
  // manifest field drives which upstream .d.ts is generated.
  mixin.mixin(pkg("*/shared-sdk-model", "shared"), (p) => {
    p.addDeps("zod@catalog:");
    p.addDevDeps("@databricks/sdk-experimental@catalog:");
    p.package.addField("codegen", {
      inputs: ["node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts"],
    });
  }),

  // shared-genie: browser-safe Genie wire contracts (zod schemas that extend the
  // generated SDK shapes) + the high-level chat event vocabulary and detectors.
  mixin.mixin(pkg("*/shared-genie", "shared"), (p) => {
    p.addDeps("zod@catalog:", "@dbx-tools/shared-sdk-model@workspace:*");
  }),

  // shared-projen: the projen engine, renamed to @dbx-tools/projen. Node-tagged,
  // carries the engine's toolchain deps, exports its subpath entrypoints, and
  // compiles index.ts + tasks/ outside src/.
  mixin.mixin(pkg("*/shared-projen", "shared"), (p) => {
    p.package.addField("name", projectApi.identifier(p.root).withName("projen").packageName);
    p.dbxToolsConfig.tags.push("node");
    p.addDeps(
      "projen",
      "constructs",
      "barrelsby",
      "openapi-typescript",
      "tsoa",
      "ts-to-zod",
      "yaml",
      "tsx",
      "p-memoize",
      "commander",
      "@clack/prompts",
      "consola",
      "@typescript-eslint/typescript-estree@^8",
      "oxc-parser@^0.90.0",
      "typescript@catalog:",
      "is-identifier@^1",
      "@dbx-tools/node-core@workspace:*",
      "@dbx-tools/node-file-scan@workspace:*",
    );
    p.package.addField("exports", {
      ".": "./index.ts",
      "./log": "./src/log.ts",
      "./engine-root": "./src/engine-root.ts",
      "./package.json": "./package.json",
    });
    applyRootDirTsconfig(p, "index.ts", "tasks/**/*.ts");
  }),

  // cli-dbx-tools: the published CLI, renamed to the bare scope @dbx-tools/cli.
  // Tagged `cli` (not `shared`), so it adds its own shared-core dep. Ships the
  // `dbxtools` bin and compiles index.ts + bin/ outside src/.
  mixin.mixin(pkg("*/cli-dbx-tools", "cli"), (p) => {
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
    p.addDeps("@dbx-tools/shared-core@workspace:*", "@dbx-tools/node-core@workspace:*", "pnpm");
    applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
  }),
);

applyExampleWorkspaces(project);

project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
