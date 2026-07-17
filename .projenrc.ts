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
  // The two example `ui/*` packages are full browser apps (they ship an
  // `index.html`), so they take the `app` tag (vite build/dev/preview) on top
  // of the `ui` component surface their path already grants.
  workspacePackageTagPaths: {
    "example-workspaces/ui/app": ["app"],
    "example-workspaces/ui/appkit-client": ["app"],
  },
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

// Catalog pins for the app add-on runtime deps (not engine toolchain): the
// email add-on's markdown renderer and the Mastra agent framework the tools
// build on.
project.pnpmWorkspace?.addCatalog("marked", "^18.0.5");
project.pnpmWorkspace?.addCatalog("@mastra/core", "^1.47.0");
project.pnpmWorkspace?.addCatalog("@mastra/ai-sdk", "^1.6.0");
project.pnpmWorkspace?.addCatalog("@mastra/express", "^1.4.2");
project.pnpmWorkspace?.addCatalog("@mastra/fastembed", "^1.2.0");
project.pnpmWorkspace?.addCatalog("@mastra/mcp", "^1.12.0");
project.pnpmWorkspace?.addCatalog("@mastra/memory", "^1.21.2");
project.pnpmWorkspace?.addCatalog("@mastra/observability", "^1.15.2");
project.pnpmWorkspace?.addCatalog("@mastra/otel-bridge", "^1.4.0");
project.pnpmWorkspace?.addCatalog("@mastra/pg", "^1.14.2");
project.pnpmWorkspace?.addCatalog("@opentelemetry/api", "^1.9.1");

// Catalog pins for the React `ui` add-on stack (AppKit UI kit + Tailwind v4 +
// the Mastra chat-UI deps). These only load in ui-tagged (browser) packages.
// (`@databricks/appkit-ui` is already an engine DEFAULT_CATALOG entry;
// `@mastra/ai-sdk` is pinned above.)
project.pnpmWorkspace?.addCatalog("@tailwindcss/vite", "^4.3.1");
project.pnpmWorkspace?.addCatalog("tailwindcss", "^4.3.2");
project.pnpmWorkspace?.addCatalog("tw-animate-css", "^1.4.0");
project.pnpmWorkspace?.addCatalog("lucide-react", "^0.554.0");
project.pnpmWorkspace?.addCatalog("react-router-dom", "^7.6.2");
project.pnpmWorkspace?.addCatalog("streamdown", "^2.5.0");
project.pnpmWorkspace?.addCatalog("@mastra/client-js", "^1.28.0");
project.pnpmWorkspace?.addCatalog("@tanstack/react-table", "^8.21.3");
project.pnpmWorkspace?.addCatalog("ai", "^5.0.0");
project.pnpmWorkspace?.addCatalog("echarts", "^6.0.0");
project.pnpmWorkspace?.addCatalog("echarts-for-react", "^3.0.2");
project.pnpmWorkspace?.addCatalog("shiki", "^3.0.0");
project.pnpmWorkspace?.addCatalog("sql-formatter", "^15.6.9");
project.pnpmWorkspace?.addCatalog("nanoid", "^5.1.6");


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

  // shared-core is the light, browser-safe base: EVERY workspace package (except
  // shared-core itself) gets it automatically, regardless of tag. When in doubt,
  // reach for shared-core - so the per-package mixins below never add it.
  mixin.mixin(
    workspaces.and(projectPredicate.hasName("@dbx-tools/shared-core").negate()),
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
  // / fs / process depends on node-core instead. (shared-core is added by the
  // blanket base-dep mixin above, so this package needs no mixin of its own.)

  // node-appkit: the base for Node-side AppKit + experimental-SDK helpers.
  // Houses the SDK Context/AbortSignal adapter so the browser-safe shared-core
  // stays SDK-free. The Databricks SDK is a runtime dep here; `@databricks/appkit`
  // (used by `plugin.ts` for the execution-context + plugin-lookup helpers) is an
  // OPTIONAL peer so browser/test consumers that only touch `databricks.ts` needn't
  // install it. `config.ts` (app.yaml / bundle env resolution) needs zod + yaml
  // and depends on node-core for project-root discovery.
  mixin.mixin(pkg("*/node-appkit", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/node-core@workspace:*",
      "@databricks/sdk-experimental@catalog:",
      "zod@catalog:",
      "yaml",
    );
    p.addPeerDeps("@databricks/appkit@catalog:");
    p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
    p.addDevDeps("@databricks/appkit@catalog:");
  }),

  // cli-appkit-env: the `appkit-env` CLI - run AppKit auto-config (node-appkit's
  // `createApp.autoConfigure`) and print the env vars it added/changed as
  // eval-able shell / windows / json output. `cli`-tagged (commander from the
  // cli tag).
  mixin.mixin(pkg("*/cli-appkit-env", "cli"), (p) => {
    p.package.addField("name", projectApi.identifier(p.root).withName("appkit-env").packageName);
    p.package.file.readonly = false;
    p.package.addField("publishConfig", { access: "public", provenance: true });
    p.package.addBin({ "appkit-env": "./bin/appkit-env.ts" });
    p.package.addField("exports", {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
    p.addDeps("@dbx-tools/node-appkit@workspace:*", "@databricks/appkit@catalog:");
    applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
  }),

  // node-genie: the server-side Genie driver (live chat + space metadata).
  // Consumes the browser-safe shared-genie contracts, node-appkit's SDK glue,
  // and the SDK at runtime. AppKit is an OPTIONAL peer - the client resolver
  // lazy-imports it and falls back to env-var auth when it's absent.
  mixin.mixin(pkg("*/node-genie", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-genie@workspace:*",
      "@dbx-tools/node-appkit@workspace:*",
      "@databricks/sdk-experimental@catalog:",
    );
    p.addPeerDeps("@databricks/appkit@catalog:");
    p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
    p.addDevDeps("@databricks/appkit@catalog:");
  }),

  // node-model: the server-side model resolver (cached Model Serving listing +
  // fuzzy name resolution, workspace-aware selection, offline fallback floor).
  // Consumes the browser-safe shared-model classifier + node-appkit's AppKit
  // glue. AppKit is a runtime dep here (CacheManager is used directly, not lazy).
  mixin.mixin(pkg("*/node-model", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-model@workspace:*",
      "@dbx-tools/node-appkit@workspace:*",
      "@databricks/appkit@catalog:",
      "fuse.js@^7.4.2",
    );
  }),

  // node-databricks: generic Databricks/cloud infra with NO AppKit requirement -
  // workspace URL/id resolution + cloud provider/region detection (fetches
  // AWS/GCP/Azure IP-range feeds, DNS via node:dns, disk cache). Consumes
  // node-appkit only for the optional execution-context client + node-core for
  // fs stat; the SDK is a runtime dep.
  mixin.mixin(pkg("*/node-databricks", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/node-appkit@workspace:*",
      "@dbx-tools/node-core@workspace:*",
      "@databricks/sdk-experimental@catalog:",
    );
  }),

  // node-databricks-zerobus: Zerobus streaming-ingest helpers. Uses the Zerobus
  // SDK directly (no AppKit); resolves the region-aware endpoint via
  // node-databricks (workspace URL/id + cloud location).
  mixin.mixin(pkg("*/node-databricks-zerobus", "node"), (p) => {
    p.addDeps("@dbx-tools/node-databricks@workspace:*", "@databricks/zerobus-ingest-sdk@^1.1.0");
  }),

  // node-email: server-side email add-on - SMTP transport (nodemailer) / local
  // outbox, markdown->HTML rendering (marked + juice), on-behalf-of sender
  // derivation, the approval-gated `send_email` Mastra tool, and the AppKit
  // `email` plugin. Consumes the browser-safe shared-email contract. AppKit +
  // Mastra are runtime deps.
  mixin.mixin(pkg("*/node-email", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-email@workspace:*",
      "@databricks/appkit@catalog:",
      "@mastra/core@catalog:",
      "nodemailer@^7.0.13",
      "juice@^12.1.1",
      "marked@catalog:",
    );
    p.addDevDeps("@types/nodemailer@^7", "@types/express@catalog:", "@types/json-schema@^7");
  }),

  // node-appkit-mastra: the AppKit Mastra agent layer - agents, memory, MCP, observability,
  // the Genie/model/chart/history tooling, and the AppKit `mastra` plugin +
  // Express server. One package: nearly every module needs @mastra/core and the
  // plugin composes memory/mcp/observability/server together, so the heavy deps
  // (pg, fastembed, mcp, observability, express) can't be gated apart.
  mixin.mixin(pkg("*/node-appkit-mastra", "node"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-mastra@workspace:*",
      "@dbx-tools/shared-genie@workspace:*",
      "@dbx-tools/shared-model@workspace:*",
      "@dbx-tools/node-genie@workspace:*",
      "@dbx-tools/node-model@workspace:*",
      "@dbx-tools/node-appkit@workspace:*",
      "@dbx-tools/node-core@workspace:*",
      "@dbx-tools/node-databricks@workspace:*",
      "@databricks/sdk-experimental@catalog:",
      "@databricks/appkit@catalog:",
      "@mastra/core@catalog:",
      "@mastra/ai-sdk@catalog:",
      "@mastra/express@catalog:",
      "@mastra/fastembed@catalog:",
      "@mastra/mcp@catalog:",
      "@mastra/memory@catalog:",
      "@mastra/observability@catalog:",
      "@mastra/otel-bridge@catalog:",
      "@mastra/pg@catalog:",
      "@opentelemetry/api@catalog:",
      "zod@catalog:",
      "pg@^8.22.0",
    );
    p.addDevDeps("@types/express@catalog:", "@types/pg@^8");
  }),

  // node-path: filesystem path helpers - glob find, ignore rules, path
  // matching, package scan, and watch. It shells out (node-core exec) and uses
  // chokidar/glob, so it lives under workspaces/node/ (the `node` tag
  // auto-applies). Pin explicit ranges: bare names resolve against the local
  // registry, which can return stale majors (e.g. minimatch@3 lacks the
  // `{ Minimatch }` ESM export the code imports, chokidar@1 predates the v4 API).
  mixin.mixin(pkg("*/node-path", "node"), (p) => {
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

  // shared-email: browser-safe zod wire contract for the email add-on (message
  // + result + sender options). Pure zod, shared by the server sender, Mastra
  // tool, and React approval UI.
  mixin.mixin(pkg("*/shared-email", "shared"), (p) => {
    p.addDeps("zod@catalog:");
  }),

  // shared-mastra: browser-safe wire contract + embed-marker grammar + route
  // segments for the Mastra add-on's clientConfig surface. Pure zod; extends
  // the genie + model wire schemas.
  mixin.mixin(pkg("*/shared-mastra", "shared"), (p) => {
    p.addDeps(
      "zod@catalog:",
      "@dbx-tools/shared-genie@workspace:*",
      "@dbx-tools/shared-model@workspace:*",
    );
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

  // node-projen: the projen engine, renamed to @dbx-tools/projen. Lives under
  // workspaces/node/ (it uses node: builtins, tsx, child_process), so the `node`
  // tag auto-applies. Carries the engine's toolchain deps, exports its subpath
  // entrypoints, and compiles index.ts + tasks/ outside src/.
  mixin.mixin(pkg("*/node-projen", "node"), (p) => {
    p.package.addField("name", projectApi.identifier(p.root).withName("projen").packageName);
    p.addDeps(
      "projen",
      "constructs",
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
      "@dbx-tools/node-path@workspace:*",
    );
    p.package.addField("exports", {
      ".": "./index.ts",
      "./engine-root": "./src/engine-root.ts",
      "./package.json": "./package.json",
    });
    applyRootDirTsconfig(p, "index.ts", "tasks/**/*.ts");
  }),

  // cli-dbx-tools: the published CLI, renamed to the bare scope @dbx-tools/cli.
  // Ships the `dbxtools` bin and compiles index.ts + bin/ outside src/.
  // (shared-core comes from the blanket base-dep mixin above.)
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
    p.addDeps("@dbx-tools/node-core@workspace:*", "pnpm");
    applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
  }),

  // cli-model-proxy: local OpenAI-compatible proxy in front of Databricks Model
  // Serving. `cli`-tagged (commander comes from the cli tag). Reuses node-model's
  // resolver + shared-model contracts; the SDK is a runtime dep for auth/host.
  // Ships the `model-proxy` bin and compiles index.ts + bin/ outside src/.
  mixin.mixin(pkg("*/cli-model-proxy", "cli"), (p) => {
    p.package.addField("name", projectApi.identifier(p.root).withName("model-proxy").packageName);
    p.package.file.readonly = false;
    p.package.addField("publishConfig", { access: "public", provenance: true });
    p.package.addBin({ "model-proxy": "./bin/model-proxy.ts" });
    p.package.addField("exports", {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
    p.addDeps(
      "@dbx-tools/node-model@workspace:*",
      "@dbx-tools/shared-model@workspace:*",
      "@databricks/sdk-experimental@catalog:",
    );
    applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
  }),

  // ui-appkit: the shared React UI base for the feature UI packages. Re-exports
  // AppKit's UI kit (`@databricks/appkit-ui/react`), the default Vite plugins
  // (React + Tailwind v4), and the shared stylesheet. `ui`-tagged (React + vite
  // + jsx come from the ui tag). Subpath exports match the -js layout.
  mixin.mixin(pkg("*/ui-appkit", "ui"), (p) => {
    p.addDeps(
      "@databricks/appkit-ui@catalog:",
      "@tailwindcss/vite@catalog:",
      "@vitejs/plugin-react@catalog:",
      "tailwindcss@catalog:",
      "streamdown@catalog:",
    );
    // Ships a Vite plugin preset (`./vite`), so it needs vite + the React
    // plugin as real deps - the `ui` tag is a component library and no longer
    // carries the vite toolchain (that moved to the `app` tag).
    p.addDevDeps("vite@catalog:");
    p.package.addField("exports", {
      "./react": "./src/react/index.ts",
      "./vite": "./src/vite.ts",
      "./styles.css": "./src/styles.css",
      "./package.json": "./package.json",
    });
  }),

  // ui-email: the React surface for the email add-on - an Approve/Deny approval
  // card for the `send_email` tool, its read-only field preview, and a standard
  // editable compose view. Presentational; consumes the browser-safe
  // shared-email wire contract and renders through ui-appkit's UI kit + the
  // shared Markdown/Tailwind styling. `ui`-tagged (React + jsx from the ui tag).
  mixin.mixin(pkg("*/ui-email", "ui"), (p) => {
    p.addDeps(
      "@dbx-tools/shared-email@workspace:*",
      "@dbx-tools/ui-appkit@workspace:*",
      "lucide-react@catalog:",
      "streamdown@catalog:",
    );
    p.package.addField("exports", {
      "./react": "./src/react/index.ts",
      "./styles.css": "./src/styles.css",
      "./package.json": "./package.json",
    });
  }),
);

applyExampleWorkspaces(project);

project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
