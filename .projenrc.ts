/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `workspacePackageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `src`-bearing package folder at any depth under
 * `workspaces/`. The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `workspaces/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * The runnable sample app lives in its own standalone project under `demo/` (its
 * own `demo/.projenrc.ts` + nested pnpm workspace, consuming the published
 * `@dbx-tools/*` packages) - it is NOT part of this synth.
 *
 * Per-package tweaks are MIXINS applied with `project.mixin(...)` (constructs-
 * native, across the subtree; the built-in tag mixins already ran during
 * construction). `synth()` is called manually because this repo adds a thin `dbxtools`
 * root task first (see below); a normal consumer constructs, `with(...)`s, synths.
 */
import { JsonFile, Project } from "projen";
import { mixin, project, project as projectApi } from "@dbx-tools/projen";

const SCOPE = "dbx-tools";

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
const root = new projectApi.DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  workspacePackageRoots: ["workspaces"],
  github: true,
  buildWorkflow: true,
  // No projen-managed release component: releasing is a `bump` task (added by
  // the engine, tag prefix `v`) plus the tag-driven `release` workflow authored
  // below - the same model as the standalone `projen/` project.
  release: false,
  releaseTagPrefix: "v",
  // The standalone `@dbx-tools/projen` engine lives in `projen/` (not a
  // workspace member) and releases on its own `projen-v*` tag prefix; the engine
  // authors its `projen-release` workflow alongside the root's `release`.
  standaloneReleases: [{ name: "projen-release", directory: "projen", tagPrefix: "projen-v" }],
  workflowPackageCache: true,
  depsUpgrade: false,
  // `@dbx-tools/projen` (the engine) lives in the standalone `projen/`
  // project, not this workspace; the repo `.pnpmfile.cjs` rewrites it to a
  // `link:./projen`. It stays a plain dep here so synth can resolve it.
  devDeps: [
    "concurrently",
    "@dbx-tools/shared-core@workspace:*",
    "@dbx-tools/projen@*",
    // shared-core's public brand namespace is Zod-backed and is loaded while
    // this projen definition evaluates through the workspace dependency.
    "zod@catalog:",
  ],
});

// ---------------------------------------------------------------------------
// pnpm workspace: build-script allowances + version overrides
// ---------------------------------------------------------------------------
root.pnpmWorkspace?.allowBuild("@databricks/appkit-ui");
root.pnpmWorkspace?.allowBuild("@databricks/appkit");
root.pnpmWorkspace?.allowBuild("@google/genai", true);
root.pnpmWorkspace?.allowBuild("protobufjs", true);
root.pnpmWorkspace?.allowBuild("agent-browser", false);
root.pnpmWorkspace?.allowBuild("bufferutil", false);
root.pnpmWorkspace?.allowBuild("edgedriver", false);
root.pnpmWorkspace?.allowBuild("geckodriver", false);
root.pnpmWorkspace?.allowBuild("onnxruntime-node", false);
root.pnpmWorkspace?.addOverride("overrides.glob", "^13.0.0");

// Catalog pins for the app add-on runtime deps (not engine toolchain): the
// email add-on's markdown renderer and the Mastra agent framework the tools
// build on.
root.pnpmWorkspace?.addCatalog("marked", "^18.0.5");
root.pnpmWorkspace?.addCatalog("@mastra/core", "^1.47.0");
root.pnpmWorkspace?.addCatalog("@mastra/ai-sdk", "^1.6.0");
root.pnpmWorkspace?.addCatalog("@mastra/express", "^1.4.2");
root.pnpmWorkspace?.addCatalog("@mastra/fastembed", "^1.2.0");
root.pnpmWorkspace?.addCatalog("@mastra/mcp", "^1.12.0");
root.pnpmWorkspace?.addCatalog("@mastra/memory", "^1.21.2");
root.pnpmWorkspace?.addCatalog("@mastra/observability", "^1.15.2");
root.pnpmWorkspace?.addCatalog("@mastra/otel-bridge", "^1.4.0");
root.pnpmWorkspace?.addCatalog("@mastra/pg", "^1.14.2");
root.pnpmWorkspace?.addCatalog("@opentelemetry/api", "^1.9.1");

// Catalog pins for the React `ui` add-on stack (AppKit UI kit + Tailwind v4 +
// the Mastra chat-UI deps). These only load in ui-tagged (browser) packages.
// (`@databricks/appkit-ui` is already an engine DEFAULT_CATALOG entry;
// `@mastra/ai-sdk` is pinned above.)
root.pnpmWorkspace?.addCatalog("@tailwindcss/vite", "^4.3.1");
root.pnpmWorkspace?.addCatalog("tailwindcss", "^4.3.2");
root.pnpmWorkspace?.addCatalog("tw-animate-css", "^1.4.0");
root.pnpmWorkspace?.addCatalog("lucide-react", "^0.554.0");
root.pnpmWorkspace?.addCatalog("react-router-dom", "^7.6.2");
root.pnpmWorkspace?.addCatalog("streamdown", "^2.5.0");
root.pnpmWorkspace?.addCatalog("@mastra/client-js", "^1.28.0");
root.pnpmWorkspace?.addCatalog("@tanstack/react-table", "^8.21.3");
root.pnpmWorkspace?.addCatalog("ai", "^5.0.0");
root.pnpmWorkspace?.addCatalog("echarts", "^6.0.0");
root.pnpmWorkspace?.addCatalog("echarts-for-react", "^3.0.2");
root.pnpmWorkspace?.addCatalog("shiki", "^3.0.0");
root.pnpmWorkspace?.addCatalog("sql-formatter", "^15.6.9");
root.pnpmWorkspace?.addCatalog("nanoid", "^5.1.6");


// ---------------------------------------------------------------------------
// Per-package mixins
// ---------------------------------------------------------------------------
// File-level and negated-selector mixins that don't fit the project-selector
// The root's own tsconfig targets a file, not a project, so it stays a raw mixin.
root.with(
  mixin.create(
    (file): file is JsonFile =>
      file instanceof JsonFile &&
      file.path === "tsconfig.json" &&
      file.project === root,
    (file) => {
      file.addOverride("include", [".projenrc.ts"]);
    },
  ),
);

// ---------------------------------------------------------------------------
// Per-package dependency rules (selected by package name + tag)
// ---------------------------------------------------------------------------

// shared-core is the light, browser-safe base: EVERY workspace package (except
// shared-core itself) gets it automatically, regardless of tag. When in doubt,
// reach for shared-core - so the per-package rules below never add it.
project.applyToProjects(root, { path: "workspaces/**", identifierName: "!shared-core" }, (p) => {
  p.addDeps("@dbx-tools/shared-core@workspace:*");
});

// shared-core: the browser-safe base every package builds on. consola is an
// OPTIONAL peer: the `log` module lazy-imports it and degrades to a console
// fallback when it's absent, so consumers may leave it uninstalled. Version
// tracks the hardcoded DEFAULT_CATALOG entry.
project.applyToProjects(root, { identifierName: "shared-core", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
  p.addPeerDeps("consola@catalog:");
  p.package.addField("peerDependenciesMeta", { consola: { optional: true } });
  // Present for local dev/typecheck; consumers opt in via the catalog.
  p.addDevDeps("consola@catalog:");
});

// node-core: the Node-only half of the shared runtime (exec + project). Lives
// under workspaces/node/, so the `node` tag auto-applies (node types + ES2022
// lib, no DOM). shared-core stays browser-safe; anything needing child_process
// / fs / process depends on node-core instead. (shared-core is added by the
// blanket base-dep mixin above, so this package needs no rule of its own.)
project.applyToProjects(root, { identifierName: "core", tags: "node" }, (p) => {
  p.addDeps("yaml");
});

// node-appkit: the base for Node-side AppKit + experimental-SDK helpers.
// Houses the SDK Context/AbortSignal adapter so the browser-safe shared-core
// stays SDK-free. The Databricks SDK is a runtime dep here; `@databricks/appkit`
// (used by `plugin.ts` for the execution-context + plugin-lookup helpers) is an
// OPTIONAL peer so browser/test consumers that only touch `databricks.ts` needn't
// install it. `config.ts` (app.yaml / bundle env resolution) needs zod + yaml
// and depends on node-core for project-root discovery.
project.applyToProjects(root, { identifierName: "appkit", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "@databricks/sdk-experimental@catalog:",
    "zod@catalog:",
    "yaml",
  );
  p.addPeerDeps("@databricks/appkit@catalog:");
  p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
  p.addDevDeps("@databricks/appkit@catalog:");
});

// cli-appkit-env: the `appkit-env` CLI - run AppKit auto-config (node-appkit's
// `createApp.autoConfigure`) and print the env vars it added/changed as
// eval-able shell / windows / json output. `cli`-tagged (commander from the
// cli tag).
project.applyToProjects(root, { identifierName: "cli-appkit-env", tags: "cli" }, (p) => {
  p.package.addField("name", projectApi.identifier(p.root).withName("appkit-env").packageName);
  p.package.file.readonly = false;
  p.package.addBin({ "appkit-env": "./bin/appkit-env.ts" });
  // exports: `.` + `./package.json` come from the `cli` tag default.
  p.addDeps("@dbx-tools/appkit@workspace:*", "@databricks/appkit@catalog:");
  applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
});

// node-genie: the server-side Genie driver (live chat + space metadata).
// Consumes the browser-safe shared-genie contracts, node-appkit's SDK glue,
// and the SDK at runtime. AppKit is an OPTIONAL peer - the client resolver
// lazy-imports it and falls back to env-var auth when it's absent.
project.applyToProjects(root, { identifierName: "genie", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-genie@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@databricks/sdk-experimental@catalog:",
  );
  p.addPeerDeps("@databricks/appkit@catalog:");
  p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
  p.addDevDeps("@databricks/appkit@catalog:");
});

// node-model: the server-side model resolver (cached Model Serving listing +
// fuzzy name resolution, workspace-aware selection, offline fallback floor).
// Consumes the browser-safe shared-model classifier + node-appkit's AppKit
// glue. AppKit is a runtime dep here (CacheManager is used directly, not lazy).
project.applyToProjects(root, { identifierName: "model", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-model@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@databricks/appkit@catalog:",
    "fuse.js@^7.4.2",
  );
});

// node-databricks: generic Databricks/cloud infra with NO AppKit requirement -
// workspace URL/id resolution + cloud provider/region detection (fetches
// AWS/GCP/Azure IP-range feeds, DNS via node:dns, disk cache). Consumes
// node-appkit only for the optional execution-context client + node-core for
// fs stat; the SDK is a runtime dep.
project.applyToProjects(root, { identifierName: "databricks", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@databricks/sdk-experimental@catalog:",
  );
});

// node-databricks-zerobus: Zerobus streaming-ingest helpers. Uses the Zerobus
// SDK directly (no AppKit); resolves the region-aware endpoint via
// node-databricks (workspace URL/id + cloud location).
project.applyToProjects(root, { identifierName: "databricks-zerobus", tags: "node" }, (p) => {
  p.addDeps("@dbx-tools/databricks@workspace:*", "@databricks/zerobus-ingest-sdk@^1.1.0");
});

// node-email: server-side email add-on - SMTP transport (nodemailer) / local
// outbox, markdown->HTML rendering (marked + juice), on-behalf-of sender
// derivation, the approval-gated `send_email` Mastra tool, and the AppKit
// `email` plugin. Consumes the browser-safe shared-email contract. AppKit +
// Mastra are runtime deps.
project.applyToProjects(root, { identifierName: "email", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-email@workspace:*",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    "nodemailer@^7.0.13",
    "juice@^12.1.1",
    "marked@catalog:",
  );
  p.addDevDeps("@types/nodemailer@^7", "@types/express@catalog:", "@types/json-schema@^7");
});

// node-appkit-mastra: the AppKit Mastra agent layer - agents, memory, MCP, observability,
// the Genie/model/chart/history tooling, and the AppKit `mastra` plugin +
// Express server. One package: nearly every module needs @mastra/core and the
// plugin composes memory/mcp/observability/server together, so the heavy deps
// (pg, fastembed, mcp, observability, express) can't be gated apart.
project.applyToProjects(root, { identifierName: "appkit-mastra", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-mastra@workspace:*",
    "@dbx-tools/shared-genie@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@dbx-tools/genie@workspace:*",
    "@dbx-tools/model@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/databricks@workspace:*",
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
});

// node-path: filesystem path helpers - glob find, ignore rules, path
// matching, package scan, and watch. It shells out (node-core exec) and uses
// chokidar/glob, so it lives under workspaces/node/ (the `node` tag
// auto-applies). Pin explicit ranges: bare names resolve against the local
// registry, which can return stale majors (e.g. minimatch@3 lacks the
// `{ Minimatch }` ESM export the code imports, chokidar@1 predates the v4 API).
project.applyToProjects(root, { identifierName: "path", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "glob@^10.5.0",
    "chokidar@^4.0.3",
    "minimatch@^10.2.5",
  );
});

// shared-model: browser-safe zod wire contracts + pure endpoint classifier.
project.applyToProjects(root, { identifierName: "shared-model", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
});

// shared-email: browser-safe zod wire contract for the email add-on (message
// + result + sender options). Pure zod, shared by the server sender, Mastra
// tool, and React approval UI.
project.applyToProjects(root, { identifierName: "shared-email", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
});

// shared-mastra: browser-safe wire contract + embed-marker grammar + route
// segments for the Mastra add-on's clientConfig surface. Pure zod; extends
// the genie + model wire schemas.
project.applyToProjects(root, { identifierName: "shared-mastra", tags: "shared" }, (p) => {
  p.addDeps(
    "zod@catalog:",
    "@dbx-tools/shared-genie@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
  );
});

// shared-sdk-model: zod schemas generated by `dbxtools codegen` from the
// Databricks SDK .d.ts. The generated modules only need zod at runtime; the
// SDK is a devDep (codegen reads its declarations). The `codegen.inputs`
// manifest field drives which upstream .d.ts is generated.
project.applyToProjects(root, { identifierName: "shared-sdk-model", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
  p.addDevDeps("@databricks/sdk-experimental@catalog:");
  p.package.addField("codegen", {
    inputs: ["node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts"],
  });
});

// shared-genie: browser-safe Genie wire contracts (zod schemas that extend the
// generated SDK shapes) + the high-level chat event vocabulary and detectors.
project.applyToProjects(root, { identifierName: "shared-genie", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:", "@dbx-tools/shared-sdk-model@workspace:*");
});

// The projen engine (`@dbx-tools/projen`) is no longer a member of this
// workspace - it lives in the standalone `projen/` project and is linked
// in via the repo `.pnpmfile.cjs`. So there is no engine rule here.

// cli-dbx-tools: the published CLI, renamed to the bare scope @dbx-tools/cli.
// Ships the `dbxtools` bin and compiles index.ts + bin/ outside src/.
// (shared-core comes from the blanket base-dep mixin above.)
project.applyToProjects(root, { identifierName: "cli-dbx-tools", tags: "cli" }, (p) => {
  p.package.addField("name", `@${SCOPE}/cli`);
  p.package.file.readonly = false;
  p.package.addBin({ dbxtools: "./bin/dbxtools.ts" });
  // Adds `./pnpm` on top of the `cli` tag's `.` + `./package.json` default.
  projectApi.addExports(p, { "./pnpm": "./src/pnpm.ts" });
  p.addDeps("@dbx-tools/core@workspace:*", "pnpm");
  applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
});

// cli-model-proxy: local OpenAI-compatible proxy in front of Databricks Model
// Serving. `cli`-tagged (commander comes from the cli tag). Reuses node-model's
// resolver + shared-model contracts; the SDK is a runtime dep for auth/host.
// Ships the `model-proxy` bin and compiles index.ts + bin/ outside src/.
project.applyToProjects(root, { identifierName: "cli-model-proxy", tags: "cli" }, (p) => {
  p.package.addField("name", projectApi.identifier(p.root).withName("model-proxy").packageName);
  p.package.file.readonly = false;
  p.package.addBin({ "model-proxy": "./bin/model-proxy.ts" });
  // exports: `.` + `./package.json` come from the `cli` tag default.
  p.addDeps(
    "@dbx-tools/model@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@databricks/sdk-experimental@catalog:",
  );
  applyRootDirTsconfig(p, "index.ts", "bin/**/*.ts");
});

// ui-appkit: the shared React UI base for the feature UI packages. Re-exports
// AppKit's UI kit (`@databricks/appkit-ui/react`), the default Vite plugins
// (React + Tailwind v4), and the shared stylesheet. `ui`-tagged (React + vite
// + jsx come from the ui tag). Subpath exports match the -js layout.
project.applyToProjects(root, { identifierName: "ui-appkit", tags: "ui" }, (p) => {
  p.addDeps(
    "@databricks/appkit-ui@catalog:",
    // The brand->AppKit token bridge ships here via `styles.css`
    // (`@import "@dbx-tools/ui-branding/brand-bridge.css"`), so every feature
    // UI package that depends on this base carries the (inert-by-default)
    // bridge. Scoped to `:root[data-brand]`, so it never disturbs AppKit.
    "@dbx-tools/ui-branding@workspace:*",
    "@tailwindcss/vite@catalog:",
    "@vitejs/plugin-react@catalog:",
    "tailwindcss@catalog:",
    "streamdown@catalog:",
  );
  // Ships a Vite plugin preset (`./vite`), so it needs vite + the React
  // plugin as real deps - the `ui` tag is a component library and no longer
  // carries the vite toolchain (that moved to the `app` tag).
  p.addDevDeps("vite@catalog:");
  // Adds `./vite` on top of the `ui` tag's `./react` + `./styles.css` default.
  projectApi.addExports(p, { "./vite": "./src/vite.ts" });
});

// ui-branding: portable SVG/data assets plus framework-agnostic browser helpers
// and React bindings over shared-core's BrandContext. The root branding folder
// is canonical; pre-compile regenerates the package copies and data URLs.
project.applyToProjects(root, { identifierName: "ui-branding", tags: "ui" }, (p) => {
  projectApi.addExports(p, {
    "./browser": "./src/browser.ts",
    // The brand->AppKit token bridge stylesheet. `ui-appkit/styles.css`
    // `@import`s it so it travels with every feature UI package; scoped to
    // `:root[data-brand]` so it is inert until a brand is applied.
    "./brand-bridge.css": "./src/brand-bridge.css",
    "./assets": "./src/generated/assets.ts",
    "./assets/icon-light.svg": "./src/generated/icon-light.svg",
    "./assets/icon-dark.svg": "./src/generated/icon-dark.svg",
    "./assets/logo-light.svg": "./src/generated/logo-light.svg",
    "./assets/logo-dark.svg": "./src/generated/logo-dark.svg",
  });
  p.tasks.tryFind("pre-compile")?.exec("node ../../../branding/generate-package-assets.mjs");
});

// ui-email: the React surface for the email add-on - an Approve/Deny approval
// card for the `send_email` tool, its read-only field preview, and a standard
// editable compose view. Presentational; consumes the browser-safe
// shared-email wire contract and renders through ui-appkit's UI kit + the
// shared Markdown/Tailwind styling. `ui`-tagged (React + jsx from the ui tag).
project.applyToProjects(root, { identifierName: "ui-email", tags: "ui" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-email@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "lucide-react@catalog:",
    "streamdown@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

// ui-mastra: the full Mastra chat UI - the self-contained `MastraChat`
// drop-in and its `useMastraChat` driver, the controlled `ChatView` shell, the
// `MastraPluginClient` + hooks (model catalogue, history paging, suggestions,
// inline chart/statement embeds), markdown + data-grid + chart rendering, and
// conversation-thread management. Consumes the browser-safe wire contracts
// (shared-mastra/genie/model) and renders through ui-appkit's UI kit. `ui`-tagged.
project.applyToProjects(root, { identifierName: "ui-mastra", tags: "ui" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-mastra@workspace:*",
    "@dbx-tools/shared-genie@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "@mastra/client-js@catalog:",
    "@tanstack/react-table@catalog:",
    "ai@catalog:",
    "echarts@catalog:",
    "echarts-for-react@catalog:",
    "lucide-react@catalog:",
    "marked@catalog:",
    "nanoid@catalog:",
    "shiki@catalog:",
    "sql-formatter@catalog:",
    "streamdown@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

root.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

// Both tag-driven release workflows are authored by the engine's
// `DBXToolsRelease` component (see `projen/src/release.ts`):
//   - `release` (`v*`): publishes every `@dbx-tools/*` workspace package.
//   - `projen-release` (`projen-v*`): publishes the standalone `@dbx-tools/projen`
//     engine in `projen/`, declared via the `standaloneReleases` root option above.

root.synth();
