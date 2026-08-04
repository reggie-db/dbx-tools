/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `packageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `src`-bearing package folder at any depth under
 * `js-packages/`. The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `js-packages/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * The runnable sample app lives under `example-packages/` and is synthesized as
 * part of this workspace alongside the published packages it consumes.
 *
 * Per-package tweaks are MIXINS applied with `project.applyToProjects(root, {...},
 * cb)` (constructs-native, across the subtree; the built-in tag mixins already ran
 * during construction). `synth()` is called manually because this repo adds a thin
 * `dbx-tools` root task first (see below); a normal consumer constructs,
 * `applyToProjects`es, synths.
 */
import { project, project as projectApi } from "@dbx-tools/projen";

const SCOPE = "dbx-tools";

// ---------------------------------------------------------------------------
// Root construction
// ---------------------------------------------------------------------------
const root = new projectApi.DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  // `js-packages` is the product; `example-packages` holds the runnable demo app
  // (server + React app), merged in from the former standalone `demo/` workspace
  // so it dogfoods the `@dbx-tools/*` packages as `workspace:*` source siblings.
  packageRoots: ["js-packages", "example-packages"],
  // Any pnpm-workspace setting the engine does not manage itself, typed by
  // projen's own `PnpmWorkspaceYamlSchema`. `overrides` forces every transitive
  // glob onto v13: older majors are deprecated upstream (10.x now ships under
  // the `legacy-v10` tag), so without this a dependency asking for glob@7/9/10
  // both re-installs a second copy and prints a deprecation warning on every
  // install.
  workspaceYaml: { overrides: { glob: "^13.0.0" } },
  github: true,
  buildWorkflow: true,
  // No projen-managed release component: releasing is a `bump` task (added by
  // the engine, tag prefix `v`) plus the tag-driven `release` workflow authored
  // below - the same model as the standalone `projen/` project.
  release: false,
  releaseTagPrefix: "v",
  // The `@dbx-tools/projen` engine lives in `projen/` and releases on its own
  // `projen-v*` tag prefix; the engine authors its `projen-release` workflow
  // alongside the root's `release`.
  standaloneReleases: [{ name: "projen-release", directory: "projen", tagPrefix: "projen-v" }],
  // `projen/` synthesizes ITSELF (avoiding a dogfooding cycle) so it is not a
  // root subproject, but it IS a member of the single bun workspace - listed here
  // so bun links it + its `workspace:*` sibling deps from local source.
  extraWorkspaceMembers: ["projen"],
  // Bun manages installs (build.yml uses `oven-sh/setup-bun` + `bun install`), so
  // projen's `actions/setup-node` package cache - which keys off an npm/pnpm/yarn
  // lockfile - does not apply. `setup-bun` does its own caching. Leave off.
  workflowPackageCache: false,
  depsUpgrade: false,
  // `@dbx-tools/projen` (the engine) lives in `projen/`, now a member of the
  // single bun workspace, so it links from source via `workspace:*` - no
  // `.pnpmfile.cjs`. `.projenrc.ts` imports it by source path either way.
  devDeps: [
    "concurrently",
    "@dbx-tools/shared-core@workspace:*",
    "@dbx-tools/projen@workspace:*",
    // shared-core's public brand namespace is Zod-backed and is loaded while
    // this projen definition evaluates through the workspace dependency.
    "zod@catalog:",
  ],
});

// `projen/` is an extra workspace member rather than an attached subproject, so
// the engine cannot discover its generated barrel for the root formatter.
root.prettier?.addIgnorePattern("projen/index.ts");

// ---------------------------------------------------------------------------
// Lockfile: bun.lock stays UNTRACKED (projen's `*.lock` default ignore)
// ---------------------------------------------------------------------------
// Deliberately NOT committed, same rationale the old `pnpm-lock.yaml` had here:
// a lockfile RESOLVED on a dev machine whose active npm registry is a local
// verdaccio bakes `localhost:4873` tarball URLs into `bun.lock`, and CI (which
// has no verdaccio) then fails every install with ConnectionRefused. Leaving it
// untracked makes CI resolve fresh from public npm every time. bun does not need
// a committed lockfile; the trade-off (CI re-resolves) is the same one the repo
// already accepted for pnpm. Verify before ever committing one:
//   grep -c 'localhost:4873' bun.lock

// ---------------------------------------------------------------------------
// Generated dot-directories
// ---------------------------------------------------------------------------
// The engine deliberately no longer blanket-ignores dot-paths - `**/.*` also
// excluded the DIRECTORIES holding generated files, which silently voided every
// `!` negation projen emits for them. So the dot-directories this repo actually
// generates are named here instead. Whole directories, since nothing inside any
// of them is ever committed.
root.gitignore.addPatterns(
  ".docs-build/",
  ".astro/",
  ".worktrees/",
  ".kanna/",
  ".polly/",
  ".home/",
);

// Least privilege at the workflow level: a job that omits its own
// `permissions:` inherits read-only instead of the repo-wide token default.
// Jobs that genuinely need more still declare it (self-mutation's
// `contents: write`), and a job-level block replaces this one outright.
// The two tag-driven release workflows set their own - the engine authors them
// during preSynthesize, after this file has finished evaluating.
for (const name of ["build", "pull-request-lint"]) {
  root.tryFindObjectFile(`.github/workflows/${name}.yml`)?.addOverride("permissions", {
    contents: "read",
  });
}

// Superseded PR runs are just wasted runner time. Grouping by workflow AND ref
// keeps a push to one PR from cancelling another PR's build.
//
// No `merge_group` trigger is needed on these: merges are gated by Mergify's
// own queue (`.mergify.yml`), not GitHub's native merge queue, so nothing ever
// dispatches a `merge_group` event here.
for (const name of ["build", "pull-request-lint"]) {
  root.tryFindObjectFile(`.github/workflows/${name}.yml`)?.addOverride("concurrency", {
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  });
}

// ---------------------------------------------------------------------------
// pnpm workspace: build-script allowances + version overrides
// ---------------------------------------------------------------------------
root.pnpmWorkspace?.allowBuild("@databricks/appkit-ui");
root.pnpmWorkspace?.allowBuild("@databricks/appkit");
root.pnpmWorkspace?.allowBuild("@google/genai");
root.pnpmWorkspace?.allowBuild("protobufjs");
// Catalog pins for the app add-on runtime deps (not engine toolchain): the
// email add-on's markdown renderer and the Mastra agent framework the tools
// build on.
root.pnpmWorkspace?.addCatalog("marked", "^18.0.5");
root.pnpmWorkspace?.addCatalog("@react-email/components", "^1.0.12");
root.pnpmWorkspace?.addCatalog("@react-email/render", "^2.1.0");
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
root.pnpmWorkspace?.addCatalog("undici", "^7.17.0");

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
root.pnpmWorkspace?.addCatalog("@mastra/client-js", "^1.28.0");
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

// shared-core is the light, browser-safe base: EVERY package (except
// shared-core itself) gets it automatically, regardless of tag. When in doubt,
// reach for shared-core - so the per-package rules below never add it.
project.applyToProjects(root, { path: "js-packages/**", identifierName: "!shared-core" }, (p) => {
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
// under js-packages/node/, so the `node` tag auto-applies (node types + ES2022
// lib, no DOM). shared-core stays browser-safe; anything needing child_process
// / fs / process depends on node-core instead. (shared-core is added by the
// blanket base-dep mixin above, so this package needs no rule of its own.)
project.applyToProjects(root, { identifierName: "core", tags: "node" }, (p) => {
  p.addDeps("extract-zip@^2.0.1", "tar@^7.5.22", "yaml");
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
// `appkit.autoConfigure`) and print the env vars it added/changed as
// eval-able shell / windows / json output. `cli`-tagged (commander from the
// cli tag). Keeps its auto-discovered `@dbx-tools/cli-appkit-env` name; only
// the bins are declared, as `dbx-tools-<name>` plus the short `dbxt-<name>`.
project.applyToProjects(root, { identifierName: "cli-appkit-env", tags: "cli" }, (p) => {
  p.package.addBin({
    [`${SCOPE}-appkit-env`]: "./bin/dbx-tools-appkit-env.ts",
    "dbxt-appkit-env": "./bin/dbx-tools-appkit-env.ts",
  });
  p.addDeps("@dbx-tools/appkit@workspace:*", "@databricks/appkit@catalog:");
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
    "@dbx-tools/shared-fs@workspace:*",
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
// outbox, React Email rendering, on-behalf-of sender
// derivation, the approval-gated `send_email` Mastra tool, and the AppKit
// `email` plugin. Consumes the browser-safe shared-email contract. AppKit +
// Mastra are runtime deps.
project.applyToProjects(root, { identifierName: "email", tags: "node" }, (p) => {
  p.addDeps(
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

// node-postgres: connection-correct Postgres utilities shared by packages.
// Advisory locks reserve one PoolClient for the full protected callback.
project.applyToProjects(root, { identifierName: "postgres", tags: "node" }, (p) => {
  p.addDeps("pg@^8.22.0");
  p.addPeerDeps("@databricks/appkit@catalog:");
  p.package.addField("peerDependenciesMeta", { "@databricks/appkit": { optional: true } });
  p.addDevDeps("@databricks/appkit@catalog:", "@types/pg@^8");
});

// node-teams: server-side Teams Adaptive Card add-on. A deterministic builder
// compiles the small `CardSpec` a model drafts into a valid Adaptive Card 1.5
// document, exposed as the `create_teams_card` Mastra tool + the AppKit `teams`
// plugin (which also mounts card-build / card-post routes and can POST a card
// to a Teams incoming webhook). Consumes the browser-safe shared-teams contract.
// AppKit + Mastra are runtime deps. Mirrors the node-email add-on's shape.
project.applyToProjects(root, { identifierName: "teams", tags: "node" }, (p) => {
  p.addDeps(
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

// node-search: a Meilisearch-style shortcut over Databricks AI Search
// (Vector Search). A friendly SearchClient wraps the low-level
// `vectorSearchIndexes.queryIndex` request + columnar response; the AppKit
// `search` plugin adds `search` / `universal_search` / (opt-in)
// `add_documents` tools, `/api/search` routes for a browser search box, and a
// `clientConfig` catalogue. Reuses node-model to resolve an embedding endpoint
// for index creation. Consumes the browser-safe shared-search contract.
// Mirrors the node-email add-on's shape.
project.applyToProjects(root, { identifierName: "search", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/shared-search@workspace:*",
    "@dbx-tools/shared-model@workspace:*",
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/model@workspace:*",
    "@databricks/appkit@catalog:",
    "@databricks/sdk-experimental@catalog:",
    "@mastra/core@catalog:",
    // pg powers the Lakebase full-text FALLBACK backend (a Postgres tsvector
    // index) used when no Vector Search endpoint is configured. Pinned the same
    // way node-appkit-mastra pins its Lakebase pool.
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
    "@databricks/sdk-experimental@catalog:",
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
  p.addPeerDeps("skills@^1");
  p.package.addField("peerDependenciesMeta", { skills: { optional: true } });
  p.addDevDeps("skills@^1");
});

// node-path: filesystem path helpers - glob find, ignore rules, path
// matching, package scan, and watch. It shells out (node-core exec) and uses
// chokidar/glob, so it lives under js-packages/node/ (the `node` tag
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
    "@dbx-tools/shared-core@workspace:*",
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
// The generated schemas used to be their own `shared-sdk-model` package. They are
// here now because they were never separable in practice: shared-genie was the
// only consumer, both are zod-only browser-safe contracts, and the generator
// happily writes a generated module alongside hand-written ones. Splitting them
// bought a package boundary and cost an extra hop for every Genie type. The SDK
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

// cli-dbx-tools: the published CLI. The ONLY package that overrides its
// auto-discovered name (`@dbx-tools/cli-dbx-tools` -> the bare `@dbx-tools/cli`);
// every other package keeps whatever discovery derives from its path. Ships the
// `dbx-tools` bin (plus the short `dbxt` alias - npm exposes every `bin` key as
// its own command). Tsconfig/exports come from the `cli` tag.
// (shared-core comes from the blanket base-dep mixin above.) No `pnpm` dep: the
// CLI drives `bun` (the ambient runtime) - see `src/bun.ts`.
project.applyToProjects(root, { identifierName: "cli-dbx-tools", tags: "cli" }, (p) => {
  p.package.addField("name", `@${SCOPE}/cli`);
  p.package.file.readonly = false;
  p.package.addBin({ [SCOPE]: "./bin/dbx-tools.ts", dbxt: "./bin/dbx-tools.ts" });
  p.addDeps("@clack/prompts@catalog:", "@dbx-tools/core@workspace:*");
});

// cli-model-proxy: local OpenAI-compatible proxy in front of Databricks Model
// Serving. `cli`-tagged (commander comes from the cli tag). Reuses node-model's
// resolver + shared-model contracts; the SDK is a runtime dep for auth/host.
// Keeps its auto-discovered `@dbx-tools/cli-model-proxy` name; only the bins are
// declared, as `dbx-tools-<name>` plus the short `dbxt-<name>`.
project.applyToProjects(
  root,
  { identifierName: "cli-model-proxy", tags: "cli" },
  (p) => {
    p.package.addBin({
      [`${SCOPE}-model-proxy`]: "./bin/dbx-tools-model-proxy.ts",
      "dbxt-model-proxy": "./bin/dbx-tools-model-proxy.ts",
    });
    p.addDeps(
      "@dbx-tools/model@workspace:*",
      "@dbx-tools/shared-model@workspace:*",
      "@databricks/sdk-experimental@catalog:",
      // Node bundles undici as its `fetch` implementation but exports no
      // `Agent` from a `node:` specifier, and the default 300s
      // `headersTimeout`/`bodyTimeout` kill a long or bursty model stream.
      // The package dependency is what lets the proxy hand `fetch` a
      // no-timeout dispatcher.
      "undici@catalog:",
    );
  },
);

// node-tunnel (`@dbx-tools/tunnel`): fronts a Databricks App with a public portr
// tunnel + email-OTP access gate, consumed IN-PROCESS through `@dbx-tools/appkit`'s
// `createApp` interceptor context - `createApp({ interceptor: tunnelInterceptor() })`.
// `tunnelInterceptor` sets DATABRICKS_HOST, installs/runs portr pointed at the app's
// public port, and `bindProcess`es it so the app and portr live/die as one
// (concurrently-style). The email OTP gate (allow-list + rate limit +
// CacheManager-stored codes + jose session) ships as the `authGate` AppKit plugin,
// which registers the login routes + a gating MIDDLEWARE on the app's OWN Express
// server (no separate proxy process; it keys on the `Host` header to gate only
// portr traffic). A `node`-tier library, not a CLI: no bin - the app that owns the
// tunnel is the process.
project.applyToProjects(root, { identifierName: "tunnel", tags: "node" }, (p) => {
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/core@workspace:*",
    // Browser-safe login wire schemas + the session cookie name - imported
    // statically by the gate, so a regular dep.
    "@dbx-tools/shared-email@workspace:*",
    "@databricks/appkit@catalog:",
    // Session JWT signing/verification (runtime-agnostic HS256), same as node-teams.
    "jose@^6.2.3",
  );
  // `@dbx-tools/email` is OPTIONAL: only the OTP gate's code delivery needs it, and
  // it is imported LAZILY (`send-code.ts`). A tunnel used without the gate (or in
  // `--insecure` mode) needs no mail transport, so it is an optional peer rather
  // than a hard dep; the app that mounts `authGate` provides it. Kept as a devDep
  // so it resolves for this package's own tests.
  p.addPeerDeps("@dbx-tools/email@workspace:*");
  p.package.addField("peerDependenciesMeta", { "@dbx-tools/email": { optional: true } });
  p.addDevDeps("@dbx-tools/email@workspace:*");
});

// ui-appkit: the shared React UI base for the feature UI packages. Re-exports
// AppKit's UI kit (`@databricks/appkit-ui/react`) and the shared stylesheet.
// `ui`-tagged (React + jsx come from the ui tag). Tailwind v4 is compiled by the
// `app` tag's `bun-plugin-tailwind`, so this component library ships no bundler
// preset - the old `./vite` export is gone under bun.
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
  p.package.addField("exports", {
    "./react": "./src/react/index.ts",
    "./react/auth-gate": "./src/react/auth-gate.tsx",
    "./styles.css": "./src/styles.css",
    "./package.json": "./package.json",
  });
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
// Demo app (merged from the former standalone `demo/` workspace)
// ---------------------------------------------------------------------------
// The runnable sample: an AppKit server + a React/Vite-free (bun) client, now
// members of the single workspace under `example-packages/`. They consume the
// `@dbx-tools/*` packages as `workspace:*` source siblings (no registry, no
// `.pnpmfile.cjs` linking) - editing a package is reflected immediately.

// example-packages/server/appkit-demo: the AppKit server. `server` tag supplies
// express + the `bun --watch`/`bun` dev/start tasks.
project.applyToProjects(root, { identifierName: "server-appkit-demo", tags: "server" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-server");
  // A private runnable app, not an importable library: entry is `src/server.ts`.
  p.package.addField("private", true);
  p.package.addField("main", "src/server.ts");
  p.package.addField("exports", { "./package.json": "./package.json" });
  p.addDeps(
    "@dbx-tools/appkit@workspace:*",
    "@dbx-tools/appkit-mastra@workspace:*",
    "@dbx-tools/databricks@workspace:*",
    "@dbx-tools/postgres@workspace:*",
    "@dbx-tools/email@workspace:*",
    "@dbx-tools/appkit-web-search@workspace:*",
    "@dbx-tools/teams@workspace:*",
    "@dbx-tools/search@workspace:*",
    "@dbx-tools/shared-core@workspace:*",
    // The tunnel library: the server registers `tunnelInterceptor()` on its own
    // `createApp` (public portr tunnel + email-OTP gate), so the deployed app.yaml
    // runs the server directly rather than through a wrapper bin.
    "@dbx-tools/tunnel@workspace:*",
    "@databricks/appkit@catalog:",
    "@databricks/sdk-experimental@catalog:",
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

// example-packages/app/appkit-demo: the React client. `app` tag supplies react +
// the bun dev server / `bun build` (Tailwind via bun-plugin-tailwind).
project.applyToProjects(root, { identifierName: "app-appkit-demo", tags: "app" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-app");
  p.package.addField("private", true);
  p.addDeps(
    "@dbx-tools/shared-core@workspace:*",
    "@dbx-tools/ui-appkit@workspace:*",
    "@dbx-tools/ui-branding@workspace:*",
    "@dbx-tools/ui-mastra@workspace:*",
    "@dbx-tools/ui-teams@workspace:*",
    "@dbx-tools/ui-search@workspace:*",
    // The `AuthGate` email-OTP login screen fronting the app (the server's
    // email plugin has `auth` enabled for the public tunnel).
    "@dbx-tools/ui-email@workspace:*",
    "react-router-dom@catalog:",
    // `src/index.css` `@import`s these directly, so the app declares them.
    "@databricks/appkit-ui@catalog:",
    "tw-animate-css@catalog:",
    "tailwindcss@catalog:",
  );
});

// In-repo runners for the CLI, mirroring the two bins the published
// `@dbx-tools/cli` installs (`dbx-tools` + the short `dbxt` alias). bun runs the
// `.ts` entry directly.
for (const task of [SCOPE, "dbxt"]) {
  root.addTask(task, {
    exec: "bun js-packages/cli/dbx-tools/bin/dbx-tools.ts",
    receiveArgs: true,
  });
}

// Run the demo server + client dev server together. Both are workspace members
// now, so no nested projen synth or registry install - just their bun dev tasks.
// `.env` is the committed-shape local secret file; `.env.local` optionally
// overlays it. Both `--env-file` flags are missing-file tolerant under bun, so
// a laptop with only `.env` still boots (loading `.env.local` alone used to
// leave SMTP unset and crash the email plugin at createApp).
root.addTask("demo", {
  env: {
    NODE_ENV: "development",
    BUN_CONFIG_ELIDE_LINES: "0"
  },
  exec: `
  bunx concurrently \
    --raw \
    --kill-others \
    --names server,client \
    "bun --env-file=.env run --elide-lines=0 --filter @dbx-tools/demo-appkit-server dev" \
    "bun --env-file=.env run --elide-lines=0 --filter @dbx-tools/demo-appkit-app dev"
  `.trim(),
  description: "Run the demo server and client dev servers",
});

// Both tag-driven release workflows are authored by the engine's
// `DBXToolsRelease` component (see `projen/src/release.ts`):
//   - `release` (`v*`): publishes every `@dbx-tools/*` package.
//   - `projen-release` (`projen-v*`): publishes the standalone `@dbx-tools/projen`
//     engine in `projen/`, declared via the `standaloneReleases` root option above.

root.synth();
