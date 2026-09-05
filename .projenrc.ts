/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `packageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `src`-bearing package folder at any depth under
 * `packages/js/`. The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `packages/js/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * The runnable sample app lives under `packages/example/` and is synthesized as
 * part of this workspace alongside the published packages it consumes.
 *
 * Per-package tweaks are MIXINS applied with `project.applyToProjects(root, {...},
 * cb)` (constructs-native, across the subtree; the built-in tag mixins already ran
 * during construction). `synth()` is called manually because this repo adds a thin
 * `dbx-tools` root task first (see below); a normal consumer constructs,
 * `applyToProjects`es, synths.
 */
import { project, project as projenProject, projectJs } from "@dbx-tools/projen";
import { DependencyType } from "projen";

const SCOPE = "dbx-tools";

// ---------------------------------------------------------------------------
// Root construction
// ---------------------------------------------------------------------------
const root = new projenProject.DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  // `packages/js` is the JavaScript product tree; `packages/example` holds the runnable demo app
  // (server + React app), merged in from the former standalone `demo/` workspace
  // so it dogfoods the `@dbx-tools/*` packages as `workspace:*` source siblings.
  packageRoots: ["packages/js", "packages/test", "packages/example"],
  packageTagPaths: { polyglot: ["node"] },
  github: true,
  buildWorkflow: true,
  // The `@dbx-tools/projen` engine lives in `projen/` and releases on its own
  // `projen-v*` tag prefix; the engine authors its `projen-release` workflow
  // alongside the root's `release`.
  standaloneReleases: [{ name: "projen-release", directory: "projen", tagPrefix: "projen-v" }],
  // `projen/` synthesizes ITSELF (avoiding a dogfooding cycle) so it is not a
  // root subproject, but it IS a member of the single bun workspace - listed here
  // so bun links it + its `workspace:*` sibling deps from local source.
  extraWorkspaceMembers: ["projen"],
  // `@dbx-tools/projen` (the engine) lives in `projen/`, a member of the single bun
  // workspace, so it links from source via `workspace:*`. `.projenrc.ts` imports it
  // by source path either way.
  devDeps: [
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/shared-core@workspace:*",
    "@dbx-tools/projen@workspace:*",
    // shared-core's public brand namespace is Zod-backed and is loaded while
    // this projen definition evaluates through the workspace dependency.
    "zod@catalog:",
  ],
});

const installerTest = root.addTask("test:installer", {
  description:
    "Test the standalone mise installer (set RUN_DOCKER_INSTALL_TESTS=1 for container coverage)",
});
installerTest.exec("bun test scripts/install.test.ts");
root.testTask.spawn(installerTest);

// ---------------------------------------------------------------------------
// Lockfiles stay UNTRACKED (projen's `*.lock` default ignore)
// ---------------------------------------------------------------------------
// Deliberately NOT committed: a lockfile resolved on a dev machine can bake its
// active npm or Python registry into `bun.lock` / `uv.lock`, then fail in CI or
// on another developer's machine. Local installs still generate both files, but
// the repo ignores them and CI resolves fresh. Verify before ever committing one:
//   grep -c 'localhost:4873' bun.lock

// ---------------------------------------------------------------------------
// Generated dot-directories
// ---------------------------------------------------------------------------
// The dot-directories this repo generates are named individually rather than
// covered by a blanket `**/.*`, which would also exclude the DIRECTORIES holding
// generated files and silently void every `!` negation projen emits for them.
// Whole directories, since nothing inside any of them is ever committed.
root.gitignore.addPatterns(
  ".docs-build/",
  ".astro/",
  ".worktrees/",
  ".kanna/",
  ".isaac/",
  ".polly/",
  ".home/",
  ".dev.token",
  ".dev.client.test/",
  "**/.logs/",
);

// ---------------------------------------------------------------------------
// pnpm workspace: build-script allowances + version overrides
// ---------------------------------------------------------------------------
root.pnpmWorkspace?.allowBuild("@google/genai");
// Catalog pins for the app add-on runtime deps (not engine toolchain): the
// email add-on's markdown renderer and the Mastra agent framework the tools
// build on.
root.pnpmWorkspace?.addCatalog("marked", "^18.0.5");
root.pnpmWorkspace?.addCatalog("@react-email/components", "^1.0.12");
root.pnpmWorkspace?.addCatalog("@react-email/render", "^2.1.0");
root.pnpmWorkspace?.addCatalog("@mastra/core", "1.47.0");
root.pnpmWorkspace?.addCatalog("@mastra/ai-sdk", "1.6.0");
root.pnpmWorkspace?.addCatalog("@mastra/express", "1.4.2");
root.pnpmWorkspace?.addCatalog("@mastra/fastembed", "1.2.0");
root.pnpmWorkspace?.addCatalog("@mastra/mcp", "1.12.0");
root.pnpmWorkspace?.addCatalog("@modelcontextprotocol/sdk", "^1.29.0");
root.pnpmWorkspace?.addCatalog("@mastra/memory", "1.21.2");
root.pnpmWorkspace?.addCatalog("@mastra/observability", "1.15.2");
root.pnpmWorkspace?.addCatalog("@mastra/otel-bridge", "1.4.0");
root.pnpmWorkspace?.addCatalog("@mastra/pg", "1.14.2");
root.pnpmWorkspace?.addCatalog("@opentelemetry/api", "^1.9.1");
// The wrapper tunnel CLI's reverse proxy (`dbx tunnel`). Only that one package
// pulls it, but the pin belongs with the other add-on runtime deps.
root.pnpmWorkspace?.addCatalog("http-proxy-3", "^1.23.1");
root.pnpmWorkspace?.addCatalog("better-auth", "^1.6.25");
root.pnpmWorkspace?.addCatalog("@better-auth/passkey", "^1.6.25");
root.pnpmWorkspace?.addCatalog("env-paths", "^4.0.0");

// Catalog pins for the React `ui`/`app` add-on stack (AppKit UI kit + Tailwind
// v4 + the Mastra chat-UI deps). These only load in ui/app-tagged (browser)
// packages. Tailwind is compiled by `bun-plugin-tailwind` (engine catalog
// default), so no `@tailwindcss/vite` pin. (`@databricks/appkit-ui` is already an
// engine DEFAULT_CATALOG entry; `@mastra/ai-sdk` is pinned above.)
root.pnpmWorkspace?.addCatalog("tailwindcss", "^4.3.2");
root.pnpmWorkspace?.addCatalog("tw-animate-css", "^1.4.0");
root.pnpmWorkspace?.addCatalog("lucide-react", "^0.554.0");
root.pnpmWorkspace?.addCatalog("react-router-dom", "^7.6.2");
root.pnpmWorkspace?.addCatalog("streamdown", "^2.5.0");
root.pnpmWorkspace?.addCatalog("@mastra/client-js", "1.28.0");
root.pnpmWorkspace?.addCatalog("@tanstack/react-table", "^8.21.3");
root.pnpmWorkspace?.addCatalog("ai", "^5.0.0");
root.pnpmWorkspace?.addCatalog("echarts", "^6.0.0");
root.pnpmWorkspace?.addCatalog("echarts-for-react", "^3.0.2");
root.pnpmWorkspace?.addCatalog("shiki", "^3.0.0");
root.pnpmWorkspace?.addCatalog("sql-formatter", "^15.6.9");
// The Adaptive Cards JavaScript renderer, used by the `ui-teams` package to
// render Teams cards in the browser. Browser-only (loaded in ui-tagged code).
root.pnpmWorkspace?.addCatalog("adaptivecards", "^3.0.5");

// ---------------------------------------------------------------------------
// Per-package dependency rules (selected by package name + tag)
// ---------------------------------------------------------------------------

project.applyToProjects(root, { path: "packages/test/**" }, (p) => {
  p.package.addField("name", `@${SCOPE}/test-polyglot`);
  p.package.addField("private", true);
  p.package.addField(
    "description",
    "Cross-runtime parity tests for dbx-tools JavaScript and Python packages",
  );
  p.addDeps("bun_python@github:codehz/bun_python#3fae2f3e72fa1bbcb998894ad61e72cfd809671b");
  p.package.addField("exports", {
    ".": "./index.ts",
    "./polyglot": {
      types: "./src/polygot-test.d.ts",
      default: "./src/polygot-test.ts",
    },
    "./python": "./src/python-test.ts",
    "./package.json": "./package.json",
  });
  projectJs.applyCompilerOptions(p, {
    types: ["node", "bun"],
    // bun_python ships TypeScript source with unused private fields and one
    // intentional switch fallthrough, so the private harness cannot tighten
    // these checks beyond its runtime dependency.
    noFallthroughCasesInSwitch: false,
    noUnusedLocals: false,
  });
});

for (const identifierName of ["shared-core", "appkit", "postgres", "shared-model", "model"]) {
  project.applyToProjects(root, { identifierName }, (p) => {
    p.deps.addDependency(
      "@dbx-tools/test-polyglot@workspace:*",
      DependencyType.TEST,
    );
  });
}

// shared-core is the light, browser-safe base: every package (except
// shared-core itself) gets it automatically, regardless of root or tag. When in
// doubt, reach for shared-core so per-package rules never add it.
project.applyToProjects(root, { identifierName: "!shared-core" }, (p) => {
  p.addDeps("@dbx-tools/shared-core@workspace:*");
});

// shared-core: the dependency-light, browser-safe base every package builds on.
// Its logger uses only platform console/stderr surfaces so browser bundlers do
// not retain optional bare imports that consumers must install themselves.
project.applyToProjects(root, { identifierName: "shared-core", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
});

// node-core: the Node-only half of the shared runtime (exec + project +
// layered config). Lives under packages/js/node/, so the `node` tag auto-applies
// (node types + ES2022 lib, no DOM). shared-core stays browser-safe; anything
// needing child_process / fs / process depends on node-core instead. zod is here
// for `config.ts`, which validates `databricks bundle validate` output.
// (shared-core is added by the blanket base-dep mixin above, so this package
// needs no rule of its own.) YAML belongs here because `config.ts` owns both
// bundle and app.yaml config-source parsing.
project.applyToProjects(root, { identifierName: "core", tags: "node" }, (p) => {
  p.addDeps("extract-zip@^2.0.1", "tar@^7.5.22", "yaml", "zod@catalog:");
});

// node-appkit: the base for Node-side AppKit helpers and the legacy SDK
// cancellation compatibility boundary.
// Houses the SDK Context/AbortSignal adapter so the browser-safe shared-core
// stays SDK-free. The Databricks SDK is a runtime dep here; `@databricks/appkit`
// (used by `plugin.ts` for the execution-context + plugin-lookup helpers) is an
// OPTIONAL peer so browser/test consumers that only touch `databricks.ts` needn't
// install it. Generic configuration resolution lives in node-core.
project.applyToProjects(root, { identifierName: "appkit", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "@databricks/sdk-experimental@catalog:",
    "zod@catalog:",
  );
  projectJs.addOptionalPeer(p, "@databricks/appkit@catalog:");
});

// cli-appkit-env: the `dbx appkit` command group - run AppKit auto-config
// (node-appkit's `appkit.autoConfigure`) and print the env vars it added/changed
// as eval-able shell / windows / json output. `cli`-tagged (commander from the
// cli tag) but ships NO bin: `@dbx-tools/cli` mounts its `buildProgram()` as
// `dbx appkit`, lazily, so AppKit only loads when that command is named.
project.applyToProjects(root, { identifierName: "cli-appkit-env", tags: "cli" }, (p) => {
  p.addDeps("@dbx-tools/appkit@workspace:*", "@databricks/appkit@catalog:");
});

// cli-auth: the `dbx auth` OAuth command group. Commander comes from the cli
// tag, and the native OAuth implementation stays in the generated auth binding.
project.applyToProjects(root, { identifierName: "cli-auth", tags: "cli" }, (p) => {
  p.package.addField("description", "Commander CLI for Databricks OAuth");
  p.addDeps("@dbx-tools/databricks-auth@workspace:*", "@dbx-tools/auth@workspace:*");
});

// node-genie: the server-side Genie driver (live chat + space metadata).
// Consumes the browser-safe shared-genie contracts and AppKit's public
// workspace-client facade. AppKit handles request-scoped and default auth.
project.applyToProjects(root, { identifierName: "genie", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-genie@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@databricks/appkit@catalog:",
  );
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
// node-appkit for the optional execution-context client + node-core for fs
// stat. AppKit's facade owns client construction; workspace/DBFS calls cross
// its explicit `toLegacyWorkspaceClient()` compatibility handoff.
project.applyToProjects(root, { identifierName: "databricks", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/shared-fs@workspace:*",
    "@databricks/appkit@catalog:",
  );
});

// node-databricks-zerobus: Zerobus streaming-ingest helpers. Uses the Zerobus
// SDK directly (no AppKit); resolves the region-aware endpoint via
// node-databricks (workspace URL/id + cloud location).
project.applyToProjects(root, { identifierName: "databricks-zerobus", tags: "node" }, (p) => {
  p.addDeps("@dbx-tools/databricks@workspace:*", "@databricks/zerobus-ingest-sdk@^1.1.0");
});

// node-email: server-side email add-on - SMTP transport (nodemailer) / local
// outbox, React Email rendering, on-behalf-of sender
// derivation, the approval-gated `send_email` Mastra tool, and the AppKit
// `email` plugin. Consumes the browser-safe shared-email contract. AppKit +
// Mastra are runtime deps.
project.applyToProjects(root, { identifierName: "email", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/shared-email@workspace:*",
    "@dbx-tools/shared-email-template@workspace:*",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    "@react-email/render@catalog:",
    "nodemailer@^7.0.13",
    "react@catalog:",
    "react-dom@catalog:",
  );
  p.addDevDeps("@types/nodemailer@^7", "@types/express@catalog:", "@types/json-schema@^7");
});

// node-appkit-web-search: server-side web-search add-on. `web_search` runs on
// the Databricks Model Serving native web-search tool (the model searches the
// web server-side and answers), resolving its OWN web-search-capable model
// (Gemini/GPT, via node-model's fuzzy selector) independently of the agent's
// chat model; `web_fetch` reads a page via got-scraping (Databricks has no
// page-fetch equivalent). Ships a per-provider tool-spec map, an optional
// allowed-URL glob allow-list (node-path `match`; filters citations / blocks
// fetches), per-tool approval gating, and the AppKit `web-search` plugin
// exposing both Mastra tools. Mirrors the node-email add-on's shape.
project.applyToProjects(root, { identifierName: "appkit-web-search", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/path@workspace:*",
    "@dbx-tools/model@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    "got-scraping@^4.2.1",
    "zod@catalog:",
  );
  p.addDevDeps("@types/express@catalog:", "@types/json-schema@^7");
});

// node-appkit-graphiti: AppKit lifecycle + Caddy routing for the Python Graphiti
// sidecar. The Python package owns Graphiti, Neo4j, LiteLLM, and Postgres replay;
// this package owns the AppKit plugin, child supervision, and single public port.
project.applyToProjects(root, { identifierName: "appkit-graphiti", tags: "node" }, (p) => {
  p.addDeps(
    "@databricks/appkit@catalog:",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@mastra/core@catalog:",
    "@mastra/mcp@catalog:",
    "concurrently@catalog:",
  );
  p.addDevDeps("@types/express@catalog:", "@types/json-schema@^7");
});

// node-postgres: connection-correct Postgres utilities shared by packages.
// Advisory locks reserve one PoolClient for the full protected callback.
project.applyToProjects(root, { identifierName: "postgres", tags: "node" }, (p) => {
  p.addDeps("pg@^8.22.0");
  projectJs.addOptionalPeer(p, "@databricks/appkit@catalog:");
  p.addDevDeps("@types/pg@^8");
});

// node-teams: server-side Teams Adaptive Card add-on. A deterministic builder
// compiles the small `CardSpec` a model drafts into a valid Adaptive Card 1.5
// document, exposed as the `create_teams_card` Mastra tool + the AppKit `teams`
// plugin (which also mounts card-build / card-post routes and can POST a card
// to a Teams incoming webhook). Consumes the browser-safe shared-teams contract.
// AppKit + Mastra are runtime deps. Mirrors the node-email add-on's shape.
project.applyToProjects(root, { identifierName: "teams", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/shared-teams@workspace:*",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    // Validates the Bot Framework JWT on an inbound Teams request against the
    // Azure Bot Service JWKS. `jose` is the runtime-agnostic verifier with no
    // native build step, unlike `jsonwebtoken` + `jwks-rsa`.
    "jose@^6.2.3",
    "zod@catalog:",
  );
  p.addDevDeps("@types/express@catalog:", "@types/json-schema@^7");
});

// node-search: extensions around AppKit's beta `aiSearch` plugin. Native AppKit
// owns Vector Search reads; this package adds agent tools, federated search,
// index lifecycle, and an AppKit-compatible Lakebase full-text provider.
// Reuses node-model to resolve an embedding endpoint for index creation and
// consumes the browser-safe shared-search extension contract.
project.applyToProjects(root, { identifierName: "search", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/shared-search@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/model@workspace:*",
    "@databricks/appkit@catalog:",
    "@databricks/sdk-experimental@catalog:",
    "@mastra/core@catalog:",
    // pg powers `lakebaseAiSearch`, the PostgreSQL full-text implementation of
    // AppKit's AI Search provider contract.
    "pg@^8.22.0",
    "zod@catalog:",
  );
  p.addDevDeps("@types/express@catalog:", "@types/json-schema@^7", "@types/pg@^8");
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
    "@dbx-tools/shared-fs@workspace:*",
    "@dbx-tools/databricks@workspace:*",
    "@dbx-tools/fs@workspace:*",
    "@dbx-tools/genie@workspace:*",
    "@dbx-tools/model@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/path@workspace:*",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    "@mastra/ai-sdk@catalog:",
    "@mastra/express@catalog:",
    // `plugin.ts` imports the `express` value (not just its types) to build
    // the plugin sub-app, so express is a real runtime dep - not only a peer
    // of `@mastra/express`. Declared so it resolves from this package's own
    // tree (e.g. under a source `link:`), not just when hoisted by a consumer.
    "express@catalog:",
    "@mastra/fastembed@catalog:",
    "@mastra/mcp@catalog:",
    // `@mastra/mcp` loads `@modelcontextprotocol/ext-apps`, whose SDK is a
    // peer. Some production installers omit that nested peer even though MCP
    // imports it at runtime, so publish the SDK from this package explicitly.
    "@modelcontextprotocol/sdk@catalog:",
    "@mastra/memory@catalog:",
    "@mastra/observability@catalog:",
    "@mastra/otel-bridge@catalog:",
    "@mastra/pg@catalog:",
    "@opentelemetry/api@catalog:",
    "zod@catalog:",
    "pg@^8.22.0",
  );
  p.addDevDeps("@types/express@catalog:", "@types/pg@^8");
  // `skills` (https://www.npmjs.com/package/skills) is the OPTIONAL Agent-Skills
  // CLI `remote-skills.ts` shells out to when present. Left as an optional peer
  // so consumers opt in; the runtime falls back to a direct fetch when it is
  // not installed. Present in devDeps for local typecheck/tests.
  projectJs.addOptionalPeer(p, "skills@^1");
});

// node-path: filesystem path helpers - glob find, ignore rules, path
// matching, package scan, and watch. It shells out (node-core exec) and uses
// chokidar/glob, so it lives under packages/js/node/ (the `node` tag
// auto-applies). Pin explicit ranges: bare names resolve against the local
// registry, which can return stale majors (e.g. minimatch@3 lacks the
// `{ Minimatch }` ESM export the code imports, chokidar@1 predates the v4 API).
project.applyToProjects(root, { identifierName: "path", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/core@workspace:*",
    "glob@^13.0.6",
    "chokidar@^4.0.3",
    "minimatch@^10.2.5",
  );
});

// node-fs: local-disk FileSystem implementation of the shared-fs contract.
// shared-fs stays browser-safe (types only); the Node runtime lives here.
project.applyToProjects(root, { identifierName: "fs", tags: "node" }, (p) => {
  p.addDeps("@dbx-tools/core@workspace:*", "@dbx-tools/shared-fs@workspace:*");
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

// shared-email-template: universal React Email presentation shared by the
// Node transport and browser previews. It stays free of Node/DOM APIs; JSX is
// only syntax for composing React Email's runtime-agnostic components.
project.applyToProjects(root, { identifierName: "shared-email-template", tags: "shared" }, (p) => {
  p.addDeps(
    "@react-email/components@catalog:",
    "react@catalog:",
  );
  p.addDevDeps("@types/react@catalog:");
});

// shared-teams: browser-safe zod wire contract for the Teams add-on - the
// high-level `CardSpec` a model drafts, the compiled `AdaptiveCard` envelope,
// and the `CardResult`. Pure zod, shared by the server card builder, the Mastra
// tool, and the React Adaptive Cards renderer.
project.applyToProjects(root, { identifierName: "shared-teams", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
});

// shared-search: browser-safe zod wire contract for the AI Search add-on -
// the search request / hit / result shapes, the universal-search request, the
// document + upsert shapes, and the index-catalogue client config. Pure zod,
// shared by the server client, the Mastra tools, the routes, and the React
// search box.
project.applyToProjects(root, { identifierName: "shared-search", tags: "shared" }, (p) => {
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

// shared-genie: browser-safe Genie wire contracts + the high-level chat event
// vocabulary and detectors. `src/dashboards.ts` is GENERATED here by the engine's
// synth-time codegen from the Databricks SDK `.d.ts` (the `codegen.inputs` field
// below names the input); `src/genie-model.ts` extends those schemas with the
// fields Genie ships on the wire that the SDK does not type yet.
//
// The generated schemas live HERE rather than in a package of their own: shared-genie
// is their only consumer, both are zod-only browser-safe contracts, and the generator
// writes a generated module alongside hand-written ones without complaint. A separate
// package would buy a boundary and cost an extra hop for every Genie type. The SDK
// stays a devDep - codegen reads its declarations, nothing imports it at runtime.
project.applyToProjects(root, { identifierName: "shared-genie", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
  p.addDevDeps("@databricks/sdk-experimental@catalog:");
  p.package.addField("codegen", {
    inputs: ["node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts"],
  });
});

// The projen engine (`@dbx-tools/projen`) lives in `projen/`, now a member of
// the single bun workspace (added via `extraWorkspaceMembers`). It synthesizes
// itself, so there is no engine rule here.

// cli-dbx-tools: the published CLI package. It uses the concise
// `@dbx-tools/cli` package name and ships the `dbx-tools` command plus the short
// `dbx` alias. The sibling CLI packages contribute commands
// rather than bins - `dbx appkit`, `dbx auth`, and `dbx tunnel` - and stay
// separate packages so their heavy dependencies are
// `await import()`ed only when named; see `src/cli.ts`. They are workspace deps
// here because the installed `dbx` has to be able to reach them.
// Tsconfig/exports come from the `cli` tag.
// (shared-core comes from the blanket base-dep mixin above.) No `pnpm` dep: the
// CLI drives `bun` (the ambient runtime) - see `src/bun.ts`.
project.applyToProjects(root, { identifierName: "cli-dbx-tools", tags: "cli" }, (p) => {
  p.package.addField("name", `@${SCOPE}/cli`);
  p.package.file.readonly = false;
  p.package.addBin({ [SCOPE]: "./bin/dbx-tools.ts", dbx: "./bin/dbx-tools.ts" });
  p.addDeps(
    "@clack/prompts@catalog:",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/cli-appkit-env@workspace:*",
    "@dbx-tools/cli-auth@workspace:*",
    "@dbx-tools/cli-tunnel@workspace:*",
  );
});

// cli-tunnel: the `dbx tunnel` command group - the WRAPPER path, for a project
// that cannot register node-tunnel's interceptor + `authGate` plugin in-process.
// `cli`-tagged (commander from the cli tag) and ships NO bin: `@dbx-tools/cli`
// mounts its `buildProgram()` as `dbx tunnel`, lazily, so `dbx dev` pays for
// neither the proxy nor AppKit. node-appkit + node-email are needed only by the
// gate app, which sits behind a dynamic import, so an `--insecure` run loads
// neither at runtime.
project.applyToProjects(root, { identifierName: "cli-tunnel", tags: "cli" }, (p) => {
  p.addDeps(
    "@databricks/appkit@catalog:",
    "@dbx-tools/auth-gate@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/email@workspace:*",
    "@dbx-tools/tunnel@workspace:*",
    "@dbx-tools/shared-email@workspace:*",
    "http-proxy-3@catalog:",
  );
});

// node-auth-gate: Better Auth runtime with email OTP, passkeys, caller-provided
// authorization/delivery, and Lakebase or SQLite persistence.
project.applyToProjects(root, { identifierName: "auth-gate", tags: "node" }, (p) => {
  p.addDeps(
    "@better-auth/passkey@catalog:",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/postgres@workspace:*",
    "@dbx-tools/shared-auth@workspace:*",
    "better-auth@catalog:",
    "env-paths@catalog:",
  );
});

// node-tunnel (`@dbx-tools/tunnel`): fronts a Databricks App with Portr and/or FRP
// tunnel + @dbx-tools/auth-gate passwordless gate, consumed IN-PROCESS through
// `@dbx-tools/appkit`'s `createApp` interceptor context.
// `tunnelInterceptor` sets DATABRICKS_HOST, installs/runs selected clients pointed
// at the app's public port, and `bindProcess`es them so app and tunnels live/die as one
// (concurrently-style). The authGate AppKit plugin composes Better Auth with the
// email transport and native Lakebase or SQLite storage, then registers one
// handler + gating middleware on the app's OWN Express server.
project.applyToProjects(root, { identifierName: "tunnel", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/auth-gate@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/shared-auth@workspace:*",
    "@databricks/appkit@catalog:",
    "http-proxy-3@catalog:",
  );
  // `@dbx-tools/email` is OPTIONAL: only the OTP gate's code delivery needs it, and
  // it is imported LAZILY (`send-code.ts`). A tunnel used without the gate (or in
  // `--insecure` mode) needs no mail transport, so it is an optional peer rather
  // than a hard dep; the app that mounts `authGate` provides it. Kept as a devDep
  // so it resolves for this package's own tests.
  projectJs.addOptionalPeer(p, "@dbx-tools/email@workspace:*");
});

// ui-appkit: the shared React UI base for the feature UI packages. Re-exports
// AppKit's UI kit (`@databricks/appkit-ui/react`) and the shared stylesheet.
// `ui`-tagged (React + jsx come from the ui tag). Tailwind v4 is compiled by the
// `app` tag's `bun-plugin-tailwind`, so this component library ships no bundler
// preset of its own.
project.applyToProjects(root, { identifierName: "ui-appkit", tags: "ui" }, (p) => {
  p.addDeps(
    "@databricks/appkit-ui@catalog:",
    // The brand->AppKit token bridge ships here via `styles.css`
    // (`@import "@dbx-tools/ui-branding/brand-bridge.css"`), so every feature
    // UI package that depends on this base carries the (inert-by-default)
    // bridge. Scoped to `:root[data-brand]`, so it never disturbs AppKit.
    "@dbx-tools/ui-branding@workspace:*",
    "tailwindcss@catalog:",
    "streamdown@catalog:",
  );
});

// ui-branding: portable SVG/data assets plus framework-agnostic browser helpers
// and React bindings over shared-core's BrandContext. The root branding folder
// is canonical; pre-compile regenerates the package copies and data URLs.
project.applyToProjects(root, { identifierName: "ui-branding", tags: "ui" }, (p) => {
  projenProject.addExports(p, {
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
    "@dbx-tools/shared-email-template@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    // Direct, not via ui-appkit: the sign-in gate renders the host app's mark and
    // name from the brand context, the same way ui-mastra's chat header does.
    // Already in the tree (ui-appkit depends on it), so this adds no install.
    "@dbx-tools/ui-branding@workspace:*",
    "lucide-react@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

// shared-auth: browser-safe compatibility and status schemas for passwordless auth.
project.applyToProjects(root, { identifierName: "shared-auth", tags: "shared" }, (p) => {
  p.addDeps("zod@catalog:");
});

// ui-auth: Better Auth React client, passkey-first gate, and credential manager.
project.applyToProjects(root, { identifierName: "ui-auth", tags: "ui" }, (p) => {
  p.package.addField("exports", {
    "./react": "./src/react/index.ts",
    "./package.json": "./package.json",
  });
  p.addDeps(
    "@better-auth/passkey@catalog:",
    "@dbx-tools/shared-auth@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "@dbx-tools/ui-branding@workspace:*",
    "better-auth@catalog:",
  );
});

// ui-teams: the React surface for the Teams add-on - an `AdaptiveCardView` that
// renders a compiled Adaptive Card with the `adaptivecards` JavaScript renderer,
// and a self-contained `AdaptiveCardGallery` dev tool that edits a `CardSpec`,
// compiles it through the server's `/api/teams/card` route, and previews the
// card live. Consumes the browser-safe shared-teams contract and renders
// through ui-appkit's UI kit. `ui`-tagged (React + jsx from the ui tag).
project.applyToProjects(root, { identifierName: "ui-teams", tags: "ui" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-teams@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "adaptivecards@catalog:",
    // The `adaptivecards` renderer ships no markdown parser - a `TextBlock` is
    // markdown per the spec, but the host supplies the implementation - so the
    // card view installs `marked` as its `onProcessMarkdown` processor.
    "marked@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

// ui-search: the React surface for the AI Search add-on - a debounced
// search-as-you-type `SearchBox`, a `SearchResults` list, and the `useSearch`
// hook they share, all reading the plugin's client config through AppKit's
// `usePluginClientConfig`. Presentational; consumes the browser-safe
// shared-search contract and renders through ui-appkit's UI kit. `ui`-tagged.
project.applyToProjects(root, { identifierName: "ui-search", tags: "ui" }, (p) => {
  p.addDeps(
    "@databricks/appkit-ui@catalog:",
    "@dbx-tools/shared-search@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "lucide-react@catalog:",
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
    // Direct dep: the driver reads the active brand (`useBrand`) to style the
    // chat export document (logo + colors + font). Also transitive via
    // ui-appkit, but the direct import warrants a declared dep.
    "@dbx-tools/ui-branding@workspace:*",
    "@mastra/client-js@catalog:",
    "@tanstack/react-table@catalog:",
    "ai@catalog:",
    "echarts@catalog:",
    "echarts-for-react@catalog:",
    "lucide-react@catalog:",
    "marked@catalog:",
    "shiki@catalog:",
    "sql-formatter@catalog:",
    "streamdown@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

// ---------------------------------------------------------------------------
// Demo app
// ---------------------------------------------------------------------------
// The runnable sample: an AppKit server + a bun-bundled React client, both members
// of the single workspace under `packages/example/`. They consume the
// `@dbx-tools/*` packages as `workspace:*` source siblings rather than from the
// registry, so editing a package is reflected immediately.

// packages/example/server/appkit-demo: the AppKit server. `server` tag supplies
// express + the `bun --watch`/`bun` dev/start tasks.
project.applyToProjects(root, { identifierName: "server-appkit-demo", tags: "server" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-server");
  // A private runnable app, not an importable library: entry is `src/server.ts`.
  p.package.addField("private", true);
  p.package.addField("main", "src/server.ts");
  p.package.addField("exports", { "./package.json": "./package.json" });
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/appkit-graphiti@workspace:*",
    "@dbx-tools/appkit-mastra@workspace:*",
    "@dbx-tools/core@workspace:*",
    "@dbx-tools/databricks@workspace:*",
    "@dbx-tools/postgres@workspace:*",
    "@dbx-tools/email@workspace:*",
    "@dbx-tools/appkit-web-search@workspace:*",
    "@dbx-tools/teams@workspace:*",
    "@dbx-tools/search@workspace:*",
    // The tunnel library: the server registers `tunnelInterceptor()` on its own
    // `createApp` (public portr tunnel + Better Auth gate), so the deployed app.yaml
    // runs the server directly rather than through a wrapper bin.
    "@dbx-tools/tunnel@workspace:*",
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
    "compression@^1.8.1",
    "pg@^8.22.0",
    "fuse.js@^7.4.2",
  );
  p.addDevDeps("@types/compression@^1.8.1", "@types/pg@^8", "@types/json-schema@^7");
});

// packages/example/app/appkit-demo: the React client. `app` tag supplies react +
// the bun dev server / `bun build` (Tailwind via bun-plugin-tailwind).
project.applyToProjects(root, { identifierName: "app-appkit-demo", tags: "app" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-app");
  p.package.addField("private", true);
  p.addDeps(
    "@dbx-tools/ui-appkit@workspace:*",
    "@dbx-tools/ui-branding@workspace:*",
    "@dbx-tools/ui-mastra@workspace:*",
    "@dbx-tools/ui-teams@workspace:*",
    "@dbx-tools/ui-search@workspace:*",
    "@dbx-tools/ui-auth@workspace:*",
    // Email preview remains a separate feature package from authentication.
    "@dbx-tools/ui-email@workspace:*",
    "react-router-dom@catalog:",
    // `src/index.css` `@import`s these directly, so the app declares them.
    "@databricks/appkit-ui@catalog:",
    "tw-animate-css@catalog:",
    "tailwindcss@catalog:",
  );
});

// ---------------------------------------------------------------------------
// Rust Cargo workspace
// ---------------------------------------------------------------------------
const rustWorkspace = new projenProject.DBXToolsRustWorkspace(root, {
  workspaceDependencies: {
    "async-trait": "0.1",
    base64: "0.22",
    configparser: "3",
    directories: "6",
    fs4: "0.13",
    keyring: {
      version: "3",
      features: ["apple-native", "windows-native", "sync-secret-service"],
    },
    oauth2: { version: "5", defaultFeatures: false, features: ["reqwest", "rustls-tls"] },
    open: "5",
    reqwest: { version: "0.12", defaultFeatures: false, features: ["json", "rustls-tls"] },
    serde: { version: "1", features: ["derive"] },
    "serde_json": "1",
    sha2: "0.10",
    tempfile: "3",
    thiserror: "2",
    time: { version: "0.3", features: ["serde", "formatting", "parsing"] },
    tokio: {
      version: "1",
      features: ["fs", "io-util", "macros", "net", "rt-multi-thread", "sync", "time"],
    },
    uniffi: { version: "=0.31", features: ["cli", "tokio"] },
    url: { version: "2", features: ["serde"] },
    uuid: { version: "1", features: ["v4"] },
  },
  packages: {
    auth: {
      description: "Provider-neutral OAuth, credential storage, and locking",
      defaultFeatures: ["keyring"],
      features: { keyring: ["dep:keyring"] },
      dependencies: {
        "async-trait": { workspace: true },
        base64: { workspace: true },
        directories: { workspace: true },
        fs4: { workspace: true },
        keyring: { workspace: true, optional: true },
        oauth2: { workspace: true },
        open: { workspace: true },
        reqwest: { workspace: true },
        serde: { workspace: true },
        serde_json: { workspace: true },
        sha2: { workspace: true },
        thiserror: { workspace: true },
        time: { workspace: true },
        tokio: { workspace: true },
        uniffi: { workspace: true },
        url: { workspace: true },
        uuid: { workspace: true },
      },
      devDependencies: { tempfile: { workspace: true } },
    },
    "databricks-auth": {
      description: "Databricks OAuth with secure credential storage",
      defaultFeatures: ["keyring"],
      features: { keyring: ["dbx-tools-auth/keyring"] },
      dependencies: {
        "dbx-tools-auth": { path: "../auth", version: root.version, defaultFeatures: false },
        "async-trait": { workspace: true },
        configparser: { workspace: true },
        directories: { workspace: true },
        reqwest: { workspace: true },
        serde: { workspace: true },
        sha2: { workspace: true },
        time: { workspace: true },
        tokio: { workspace: true },
        uniffi: { workspace: true },
        url: { workspace: true },
      },
      devDependencies: { tempfile: { workspace: true } },
    },
  },
});

// ---------------------------------------------------------------------------
// Python uv workspace
// ---------------------------------------------------------------------------
const pythonPackages: projenProject.PythonPackageOptions[] = [
  ...rustWorkspace.pythonPackages,
  {
    directory: "core",
    description:
      "Dependency-free configuration, identity, and mise-backed executable helpers for dbx-tools Python packages",
    dependencies: [],
  },
  {
    directory: "postgres",
    description:
      "WorkspaceClient-backed Lakebase Postgres resolution, SQLAlchemy engines, advisory locks, and LISTEN/NOTIFY topic bus",
    internalDependencies: ["core"],
    dependencies: [
      "asyncpg>=0.30",
      "databricks-sdk>=0.63.0",
      "greenlet>=3.2",
      "psycopg[binary]>=3.2.9",
      "sqlalchemy>=2.0.41",
    ],
  },
  {
    directory: "model",
    description: "Databricks Model Serving invocation, classification, and endpoint resolution",
    dependencies: ["databricks-sdk>=0.63.0", "pydantic>=2.9"],
  },
  {
    directory: "litellm",
    description:
      "LiteLLM custom provider for Databricks Model Serving with live fuzzy model resolution",
    internalDependencies: ["databricks-auth", "model"],
    dependencies: [
      "cachetools>=5.5,<7",
      "cyclopts>=4.11,<6",
      "databricks-sdk>=0.63.0",
      "diskcache>=5.6",
      // LiteLLM 1.96.2 imports `get_flat_dependant`, removed in FastAPI
      // 0.140.7. Keep the cap until LiteLLM ships its `get_flat_params` fix.
      "fastapi<0.140.7",
      // Exact because `patches.py` guards two upstream defects through private
      // LiteLLM APIs; upgrade only with offline tests and a proxy startup smoke.
      "litellm[proxy]==1.96.2",
      // Pillow lets the payload guard downscale oversize base64 images so a
      // request stays under Databricks' 32 MiB request-body limit.
      "pillow>=10.0",
    ],
    scripts: {
      "dbx-litellm": "dbx_tools.litellm.cli:main",
    },
  },
  {
    directory: "graphiti",
    description:
      "Native Graphiti MCP and Neo4j launcher with Databricks models through LiteLLM",
    internalDependencies: ["core", "litellm", "postgres"],
    dependencies: [
      "cyclopts>=4.11,<6",
      "graphiti-core==0.29.3",
      "honcho>=2,<3",
    ],
    scripts: {
      "dbx-graphiti": "dbx_tools.graphiti.cli:main",
    },
  },
];

new projenProject.DBXToolsPythonWorkspace(root, {
  packages: pythonPackages,
  dependencies: ["dbx-tools-graphiti"],
  // The exact LiteLLM pin does not support Python 3.14, so an open-ended
  // range makes uv reject the workspace even under a supported interpreter.
  requiresPython: ">=3.10,<3.14",
  // This workspace uses two trusted corporate indexes. The first can lag the
  // local devpi index, so uv must consider the pinned version from both.
  indexStrategy: "unsafe-best-match",
  lintPaths: ["packages/py", "packages/example/python", "packages/example/notebooks"],
  ruffPerFileIgnores: {
    "packages/py/litellm/src/dbx_tools/litellm/reasoning.py": ["BLE001"],
    "packages/py/postgres/src/dbx_tools/postgres/topic_bus.py": ["BLE001"],
    "packages/example/notebooks/*.py": ["BLE001", "F821"],
  },
  release: true,
});
root.addTask("demo:emitter", {
  exec: "bun scripts/run-demo.ts --emitter-only",
  description: "Emit local Python hello-world messages onto the demo bus",
});

// In-repo runners for the CLI, mirroring the two bins the published
// `@dbx-tools/cli` installs (`dbx-tools` + the short `dbx` alias). bun runs the
// `.ts` entry directly.
for (const task of [SCOPE, "dbx"]) {
  root.addTask(task, {
    exec: "bun packages/js/cli/dbx-tools/bin/dbx-tools.ts",
    receiveArgs: true,
  });
  root.package.file.addOverride(
    `scripts.${task}`,
    "bun packages/js/cli/dbx-tools/bin/dbx-tools.ts",
  );
}

// Run the demo server, client, and local Python bus emitter together. The emitter
// is a development-only process and is not referenced by app.yaml/databricks.yml.
// Both JavaScript apps are workspace members, so there is no nested projen synth
// or registry install - just their bun dev tasks.
// `.env` is the committed-shape local secret file; `.env.local` optionally
// overlays it. Both `--env-file` flags are missing-file tolerant under bun, so
// a laptop with only `.env` still boots (loading `.env.local` alone used to
// leave SMTP unset and crash the email plugin at createApp).
root.addTask("demo", {
  env: {
    NODE_ENV: "development",
    BUN_CONFIG_ELIDE_LINES: "0",
  },
  exec: "bun scripts/run-demo.ts",
  description: "Run the local demo server, client, and Python bus emitter",
});

// Both tag-driven release workflows are authored by the engine's
// `DBXToolsRelease` component (see `projen/src/release.ts`):
//   - `node-release` (after Python): publishes every `@dbx-tools/*` package.
//   - `projen-release` (`projen-v*`): publishes the standalone `@dbx-tools/projen`
//     engine in `projen/`, declared via the `standaloneReleases` root option above.

root.synth();
