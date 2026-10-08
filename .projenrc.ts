/**
 * `DBXToolsNodeProject` discovers source packages under `packages/js` and
 * `packages/example`. The published CLI at `packages/js/cli/dbx-tools` resolves
 * to `@dbx-tools/cli`; the self-synthesizing `@dbx-tools/projen` engine lives in
 * `projen/` and joins the Bun workspace through `extraWorkspaceMembers`.
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
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { bunWorkflow, project, projectJs } from "@dbx-tools/projen";
import { Component, javascript } from "projen";

const SCOPE = "dbx-tools";
const DOCS_BUILD_ROOT = ".docs-build";
const PYTHON_ROOT = "packages/py";
const GRAPHITI_UPSTREAM_COMMIT = "2a85bbbf27f3d0d07dd3a8bf6dc8700c5193c066";

/** Copy canonical branding into published package trees after synthesis. */
class BrandPackageAssets extends Component {
  /** Refresh package-local brand copies after generated manifests are available. */
  public override postSynthesize(): void {
    execFileSync("bun", [resolve(this.project.outdir, "branding/generate-package-assets.mjs")], {
      stdio: "inherit",
    });
  }
}

// ---------------------------------------------------------------------------
// Root construction
// ---------------------------------------------------------------------------
const root = new project.DBXToolsNodeProject({
  name: `@${SCOPE}/root`,
  scope: SCOPE,
  // `packages/js` is the JavaScript product tree; `packages/example` holds the
  // runnable demo app as `workspace:^` source siblings of the packages it uses.
  packageRoots: ["packages/js", "packages/example"],
  resolvePackageOptions: (pkg, defaults) => {
    if (pkg.memberPath === "packages/js/cli/dbx-tools") {
      return { ...defaults, name: `@${SCOPE}/cli` };
    }
    if (pkg.memberPath === "packages/js/ui/appkit") {
      return { ...defaults, name: `@${SCOPE}/ui` };
    }
    if (pkg.memberPath === "packages/example/server/appkit-demo") {
      return {
        ...defaults,
        name: `@${SCOPE}/demo-appkit-server`,
        entrypoint: "src/server.ts",
        publishable: false,
      };
    }
    if (pkg.memberPath === "packages/example/app/appkit-demo") {
      return { ...defaults, name: `@${SCOPE}/demo-appkit-app`, publishable: false };
    }
    return defaults;
  },
  // Product runtime pins are known at construction and belong to the native
  // workspace options. Late catalog mutation is reserved for package mixins.
  catalog: {
    marked: "^18.0.5",
    "@react-email/components": "^1.0.12",
    "@react-email/render": "^2.1.0",
    "@mastra/core": "1.71.0",
    "@mastra/ai-sdk": "1.10.5",
    "@mastra/express": "1.5.15",
    "@mastra/fastembed": "1.3.2",
    "@mastra/mcp": "2.1.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@mastra/memory": "1.32.1",
    "@mastra/observability": "1.18.1",
    "@mastra/otel-bridge": "1.5.11",
    "@mastra/pg": "1.27.1",
    "@pydantic/monty": "0.0.23",
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/core": "2.11.0",
    "@opentelemetry/sdk-trace-base": "2.8.0",
    "@opentelemetry/sdk-trace-node": "2.8.0",
    "http-proxy-3": "^1.23.1",
    "better-auth": "1.7.6",
    "@better-auth/passkey": "1.7.6",
    "@simplewebauthn/browser": "13.3.0",
    "better-call": "1.4.0",
    "env-paths": "^4.0.0",
    "cacache": "^21.0.1",
    "tailwindcss": "^4.3.2",
    "tw-animate-css": "^1.4.0",
    "lucide-react": "^0.554.0",
    "react-router-dom": "^7.6.2",
    "streamdown": "^2.5.0",
    "@mastra/client-js": "1.50.0",
    "vitest": "3.2.4",
    "@tanstack/react-table": "^8.21.3",
    "ai": "^5.0.0",
    "echarts": "^6.0.0",
    "echarts-for-react": "^3.0.2",
    "shiki": "^3.0.0",
    "sql-formatter": "^15.6.9",
    "systray2": "^2.1.4",
    "adaptivecards": "^3.0.5",
  },
  github: true,
  githubOptions: { mergify: false, pullRequestLint: false },
  autoMerge: false,
  buildWorkflow: false,
  releaseSynthesisCommands: ["bun --cwd projen .projenrc.ts"],
  releaseDocs: {
    siteUrl: "https://docs.dbx.tools",
    base: "/",
    prepareSteps: [
      { name: "Configure Pages", uses: "actions/configure-pages@v5" },
      { name: "Generate docs from READMEs", run: "bun docs/scripts/sync-readmes.mjs" },
      {
        name: "Install docs dependencies",
        run: `bun install --cwd ${DOCS_BUILD_ROOT}/site`,
      },
    ],
    buildSteps: [
      {
        name: "Generate API docs",
        run: "bun docs/scripts/generate-api-docs.mjs",
      },
      {
        name: "Check generated titles",
        run: "bun docs/scripts/check-generated-titles.mjs",
      },
      { name: "Build docs", run: `bun run --cwd ${DOCS_BUILD_ROOT}/site build` },
      {
        name: "Check generated links",
        run: `bun run --cwd ${DOCS_BUILD_ROOT}/site check-links`,
      },
    ],
    artifactPath: `${DOCS_BUILD_ROOT}/dist`,
  },
  releasePythonRoot: PYTHON_ROOT,
  releaseValidationTasks: ["test", "docs:check-source", "docs:check-readmes"],
  // `projen/` synthesizes ITSELF (avoiding a dogfooding cycle) so it is not a
  // root subproject, but it IS a member of the single bun workspace - listed here
  // so bun links it + its `workspace:^` sibling deps from local source.
  extraWorkspaceMembers: ["projen"],
  // This root consumes the workspace-local engine source, so generator edits
  // must resynthesize the product tree just like root configuration changes.
  syncResynthPaths: ["branding/brand.yaml", "branding/assets", "projen/src"],
  // `@dbx-tools/projen` (the engine) lives in `projen/`, a member of the single bun
  // workspace, so it links from source via `workspace:^`. `.projenrc.ts` imports it
  // by source path either way.
  devDeps: [
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/projen@workspace:^",
    "commander@catalog:",
    "concurrently@^10.0.3",
    "whatwg-url@14.2.0",
    "yaml@^2.9.0",
    // shared-core's public brand namespace is Zod-backed and is loaded while
    // this projen definition evaluates through the workspace dependency.
    "zod@catalog:",
  ],
});

const eslintTask = javascript.Eslint.of(root)!.eslintTask;
eslintTask.reset();
for (const paths of [
  ["packages/js/shared", "packages/js/cli"],
  ["packages/js/node"],
  ["packages/js/ui", "packages/example", "projen"],
]) {
  eslintTask.exec(
    `eslint --ext .ts,.tsx --no-error-on-unmatched-pattern ${paths.join(" ")}`,
    { receiveArgs: true },
  );
}

const sourceDocs = root.addTask("docs:check-source", {
  description: "Reject new undocumented public TypeScript exports",
});
sourceDocs.exec("bun docs/scripts/check-source-docs.mjs");

const readmeDocs = root.addTask("docs:check-readmes", {
  description: "Validate and generate documentation from package READMEs",
});
readmeDocs.exec("bun docs/scripts/sync-cli-readmes.mjs --check");
readmeDocs.exec("bun docs/scripts/sync-readmes.mjs");
readmeDocs.exec("bun docs/scripts/generate-agent-skill.mjs --check");
root.tasks.tryFind("bump")?.exec("bun docs/scripts/generate-agent-skill.mjs");

root.addTask("docs:cli", {
  description: "Update package README command references from their CLI parsers",
  exec: "bun docs/scripts/sync-cli-readmes.mjs",
});

root.addTask("ui:bundle-sizes", {
  description: "Report focused auth, email, and search browser bundle sizes",
  exec: "bun projen/tasks/ui-bundle-sizes.ts",
});
root.addTask("shared-core:usage", {
  description: "Report shared-core runtime export usage by caller kind",
  exec: "bun projen/tasks/shared-core-usage.ts",
});

// ---------------------------------------------------------------------------
// JavaScript and Python lockfiles stay UNTRACKED
// ---------------------------------------------------------------------------
// Deliberately NOT committed: a lockfile resolved on a dev machine can bake its
// active npm or Python registry into `bun.lock` / `uv.lock`, then fail in CI or
// on another developer's machine. Local installs still generate both files, but
// the repo ignores them and CI resolves fresh. Verify before ever committing one:
//   grep -c 'localhost:4873' bun.lock
// ---------------------------------------------------------------------------
root.tasks.tryFind("install:ci")?.reset("bun install");

// Generated dot-directories
// ---------------------------------------------------------------------------
// The dot-directories this repo generates are named individually rather than
// covered by a blanket `**/.*`, which would also exclude the DIRECTORIES holding
// generated files and silently void every `!` negation projen emits for them.
// Whole directories, since nothing inside any of them is ever committed.
root.gitignore.addPatterns(
  ".codex/",
  ".docs-build/",
  ".astro/",
  ".home/",
  ".kanna/",
  "**/.logs/",
);

// ---------------------------------------------------------------------------
// Per-package dependency rules (selected by package name + tag)
// ---------------------------------------------------------------------------

// shared-core: the dependency-light, browser-safe base every package builds on.
// Its logger uses only platform console/stderr surfaces so browser bundlers do
// not retain optional bare imports that consumers must install themselves.
project.applyToProjects(root, { identifierName: "shared-core", tags: "shared" }, (p) => {
  p.package.addField("description", "Browser-safe utility foundation for dbx-tools packages");
  p.addDeps("zod@catalog:");
});

// node-core: the Node-only half of the shared runtime (exec + project +
// layered config). Lives under packages/js/node/, so the `node` tag auto-applies
// (node types + ES2022 lib, no DOM). shared-core stays browser-safe; anything
// needing child_process / fs / process depends on node-core instead. zod is here
// for `config.ts`, which validates `databricks bundle validate` output.
// `dependency-resolver.ts` turns a parsed package.json into registry
// specifiers from HTTP packuments, without writing the caller's project or
// running an installer.
// shared-core is listed in the explicit source-dependent rule above. YAML
// belongs here because `config.ts` owns both
// bundle and app.yaml config-source parsing.
project.applyToProjects(root, { identifierName: "core", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Node helpers for layered configuration, binary installation, process execution, locking, project discovery, and npm dependency resolution",
  );
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "extract-zip@^2.0.1",
    "proper-lockfile@^4.1.2",
    "semver@^7.7.3",
    "tar@^7.5.22",
    "yaml",
    "zod@catalog:",
  );
  p.addDevDeps("@types/proper-lockfile@^4.1.4", "@types/semver@^7.7.1");
});

// node-auth: dependency-light Databricks authentication lifecycle. The
// package uses only platform APIs plus node-core's portable file-lock lease so
// CLI and Node consumers can reuse the same engine without an SDK dependency.
project.applyToProjects(root, { identifierName: "auth", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Databricks profile resolution and token or authentication-header production for Node.js and Bun",
  );
  p.addDeps(
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "ini@^6.0.0",
    "oauth4webapi@^3.8.8",
    "zod@catalog:",
  );
  p.addDevDeps("@types/ini@^4.1.1");
});

// node-appkit: the base for Node-side AppKit helpers and the legacy SDK
// cancellation compatibility boundary.
// Houses the SDK Context/AbortSignal adapter so the browser-safe shared-core
// stays SDK-free. The Databricks SDK is a runtime dep here; `@databricks/appkit`
// (used by `plugin.ts` for the execution-context + plugin-lookup helpers) is an
// OPTIONAL peer so browser/test consumers that only touch `databricks.ts` needn't
// install it. Generic configuration resolution lives in node-core.
project.applyToProjects(root, { identifierName: "appkit", tags: "node" }, (p) => {
  p.package.addField("description", "Node-side helpers for Databricks AppKit applications");
  p.addDeps(
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/lakebase@workspace:^",
    "@dbx-tools/postgres@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@databricks/sdk-experimental@catalog:",
    "zod@catalog:",
  );
  projectJs.addOptionalPeer(p, "@databricks/appkit@catalog:");
  p.addDevDeps("@dbx-tools/projen@workspace:^", "vitest@catalog:");
});

// Node Graphiti runtime plus its AppKit plugin subpath.
project.applyToProjects(root, { identifierName: "graphiti", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Graphiti process supervision and AppKit integration",
  );
  p.addDeps(
    "@databricks/appkit@catalog:",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-graphiti@workspace:^",
    "zod@catalog:",
  );
  p.addDevDeps("@types/json-schema@^7", "vitest@catalog:");
  project.addExports(p, {
    "./appkit": "./src/appkit/plugin.ts",
    "./appkit/config": "./src/appkit/config.ts",
  });
});

// node-genie: the server-side Genie driver (live chat + space metadata).
// Consumes the browser-safe shared-genie contracts and AppKit's public
// workspace-client facade. AppKit handles request-scoped and default auth.
project.applyToProjects(root, { identifierName: "genie", tags: "node" }, (p) => {
  p.package.addField("description", "Server-side Databricks Genie chat drivers");
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-genie@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@databricks/appkit@catalog:",
  );
});

// node-model: the server-side model resolver (cached Model Serving listing +
// fuzzy name resolution, workspace-aware selection, offline fallback floor).
// Consumes the browser-safe shared-model classifier + node-appkit's AppKit
// glue. AppKit is a runtime dep here (CacheManager is used directly, not lazy).
project.applyToProjects(root, { identifierName: "model", tags: "node" }, (p) => {
  p.package.addField("description", "Workspace-aware Databricks Model Serving selection");
  projectJs.applyIncludes(p, "scripts/**/*.ts");
  p.addDeps(
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@databricks/appkit@catalog:",
    "cacache@catalog:",
    "env-paths@catalog:",
    "fuse.js@^7.4.2",
  );
  p.addDevDeps("cheerio@^1.2.0", "@types/cacache@^20.0.1");
  p.addTask("metadata", {
    exec: "bun scripts/generate-metadata.ts",
    description: "Refresh model retirement, capability, rate-limit, and reasoning snapshots",
  });
});

// node-lakebase: Node-native Lakebase address parsing, workspace discovery,
// and short-lived database credentials shared by AppKit and the local proxy.
project.applyToProjects(root, { identifierName: "lakebase", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Node-native Lakebase address parsing, resource discovery, and database credentials",
  );
  p.addDeps(
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
  );
});

// node-databricks: workspace URL/id resolution + cloud provider/region detection (fetches
// AWS/GCP/Azure IP-range feeds, DNS via node:dns, disk cache). Consumes
// node-appkit for the optional execution-context client + node-core for fs
// stat. AppKit's facade owns client construction; workspace/DBFS calls cross
// its explicit `toLegacyWorkspaceClient()` compatibility handoff.
project.applyToProjects(root, { identifierName: "databricks", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Databricks workspace, filesystem, cloud, and network utilities",
  );
  p.addDeps(
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/cli-service@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-fs@workspace:^",
    "@databricks/appkit@catalog:",
  );
});

// node-databricks-zerobus: Zerobus streaming-ingest helpers. Uses the Zerobus
// SDK directly (no AppKit); resolves the region-aware endpoint via
// node-databricks (workspace URL/id + cloud location).
project.applyToProjects(root, { identifierName: "databricks-zerobus", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Region-aware Zerobus ingest helpers for Databricks workspaces",
  );
  p.addDeps("@dbx-tools/databricks@workspace:^", "@databricks/zerobus-ingest-sdk@^1.1.0");
});


// node-email: server-side email add-on - SMTP transport (nodemailer) / local
// outbox, React Email rendering, on-behalf-of sender
// derivation, the approval-gated `send_email` Mastra tool, and the AppKit
// `email` plugin. Consumes the browser-safe shared-email contract. AppKit +
// Mastra are runtime deps.
project.applyToProjects(root, { identifierName: "email", tags: "node" }, (p) => {
  p.package.addField("description", "Server-side email runtime, agent tools, and AppKit plugin");
  p.addDeps(
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-email@workspace:^",
    "@dbx-tools/shared-email-template@workspace:^",
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
  p.package.addField(
    "description",
    "Server-side web search runtime, Mastra tools, and AppKit plugin",
  );
  p.addDeps(
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/path@workspace:^",
    "@dbx-tools/model@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@databricks/appkit@catalog:",
    "@mastra/core@catalog:",
    "cheerio@^1.2.0",
    "entities@^4.5.0",
    "got-scraping@^4.2.1",
    "html-to-text@^9.0.5",
    "zod@catalog:",
  );
  p.addDevDeps("@types/express@catalog:", "@types/html-to-text@^9", "@types/json-schema@^7");
});

// node-postgres: connection-correct Postgres utilities shared by packages.
// Advisory locks reserve one PoolClient for the full protected callback.
project.applyToProjects(root, { identifierName: "postgres", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Connection-correct PostgreSQL advisory locks and LISTEN/NOTIFY topic bus for Node.js",
  );
  p.addDeps("@dbx-tools/lakebase@workspace:^", "@dbx-tools/shared-core@workspace:^", "pg@^8.22.0");
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
  p.package.addField(
    "description",
    "Server-side Microsoft Teams Adaptive Card runtime, agent tool, and AppKit plugin",
  );
  p.addDeps(
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-teams@workspace:^",
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
  p.package.addField(
    "description",
    "Agent tools, federated search, index lifecycle, and Lakebase full-text extensions for AppKit AI Search",
  );
  p.addDeps(
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-search@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/model@workspace:^",
    "@dbx-tools/postgres@workspace:^",
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
  p.package.addField(
    "description",
    "AppKit plugin and server-side toolkit for hosting Mastra agents in Databricks Apps",
  );
  p.addDeps(
    "@dbx-tools/shared-mastra@workspace:^",
    "@dbx-tools/shared-genie@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@dbx-tools/shared-fs@workspace:^",
    "@dbx-tools/databricks@workspace:^",
    "@dbx-tools/fs@workspace:^",
    "@dbx-tools/genie@workspace:^",
    "@dbx-tools/model@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/path@workspace:^",
    "@dbx-tools/postgres@workspace:^",
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
    "@pydantic/monty@catalog:",
    "@opentelemetry/api@catalog:",
    "@opentelemetry/core@catalog:",
    "zod@catalog:",
    "pg@^8.22.0",
  );
  p.addDevDeps(
    "@opentelemetry/sdk-trace-base@catalog:",
    "@opentelemetry/sdk-trace-node@catalog:",
    "@types/express@catalog:",
    "@types/pg@^8",
    "vitest@catalog:",
  );
  // `skills` (https://www.npmjs.com/package/skills) is the OPTIONAL Agent-Skills
  // CLI `remote-skills.ts` shells out to when present. Left as an optional peer
  // so consumers opt in; the runtime falls back to a direct fetch when it is
  // not installed. Present in devDeps for local typecheck/tests.
  projectJs.addOptionalPeer(p, "skills@^1");
});

// node-appkit-model-gateway: raw AppKit OpenAI/Anthropic protocol plugin.
// Direct Databricks and Unity Gateway paths stream without protocol re-encoding;
// ProviderV4 AI SDK packages own fallback translation. Foreground server
// construction belongs to cli-model-gateway.
project.applyToProjects(root, { identifierName: "appkit-model-gateway", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "AppKit model gateway for Databricks OpenAI, Anthropic, Codex, and AI Gateway APIs",
  );
  projectJs.applyIncludes(p, "scripts/**/*.ts");
  p.addDeps(
    "@databricks/appkit@catalog:",
    "@dbx-tools/databricks@workspace:^",
    "@dbx-tools/model@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-model-gateway@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@ai-sdk/anthropic@^4.0.0",
    "@ai-sdk/open-responses@^2.0.58",
    "@ai-sdk/openai-compatible@^3.0.62",
    "ai@^7.0.0",
    "zod@catalog:",
  );
  p.addDevDeps(
    "@types/express@catalog:",
    "@types/json-schema@^7",
    "openai@^6.16.0",
    "vitest@catalog:",
  );
  p.tasks.tryFind("post-compile")?.exec("bun scripts/copy-manifest.ts");
  projectJs.addPackageFiles(p, "dist/plugins");
});

// node-path: filesystem path helpers - glob find, ignore rules, path
// matching, package scan, and watch. It shells out (node-core exec) and uses
// chokidar/glob, so it lives under packages/js/node/ (the `node` tag
// auto-applies). Pin explicit ranges: bare names resolve against the local
// registry, which can return stale majors (e.g. minimatch@3 lacks the
// `{ Minimatch }` ESM export the code imports, chokidar@1 predates the v4 API).
project.applyToProjects(root, { identifierName: "path", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Node filesystem path toolkit for discovery, matching, ignoring, scanning, and watching",
  );
  p.addDeps(
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "glob@^13.0.6",
    "chokidar@^4.0.3",
    "minimatch@^10.2.5",
  );
});

// node-fs: local-disk FileSystem implementation of the shared-fs contract.
// shared-fs stays browser-safe (types only); the Node runtime lives here.
project.applyToProjects(root, { identifierName: "fs", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Node local-disk implementation of the dbx-tools browser-safe filesystem contract",
  );
  p.addDeps(
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-fs@workspace:^",
  );
});

// shared-model: browser-safe zod wire contracts + pure endpoint classifier.
project.applyToProjects(root, { identifierName: "shared-model", tags: "shared" }, (p) => {
  p.package.addField("description", "Browser-safe model selection contract and classifier");
  p.addDeps("@dbx-tools/shared-core@workspace:^", "zod@catalog:");
});

project.applyToProjects(root, { identifierName: "shared-model-gateway", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe model-gateway schemas and model discovery client",
  );
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "zod@catalog:",
  );
});

project.applyToProjects(root, { identifierName: "shared-graphiti", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe Graphiti options, defaults, and runtime configuration",
  );
  p.addDeps("@dbx-tools/shared-core@workspace:^", "zod@catalog:");
});

project.applyToProjects(root, { identifierName: "shared-fs", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe filesystem contract and abstract base for rooted storage backends",
  );
  p.addDeps("@dbx-tools/shared-core@workspace:^");
});

// shared-email: browser-safe zod wire contract for the email add-on (message
// + result + sender options). Pure zod, shared by the server sender, Mastra
// tool, and React approval UI.
project.applyToProjects(root, { identifierName: "shared-email", tags: "shared" }, (p) => {
  p.package.addField("description", "Browser-safe email sending schemas and inferred types");
  p.addDeps("zod@catalog:");
});

// shared-email-template: universal React Email presentation shared by the
// Node transport and browser previews. It stays free of Node/DOM APIs; JSX is
// only syntax for composing React Email's runtime-agnostic components.
project.applyToProjects(root, { identifierName: "shared-email-template", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Universal React Email presentation shared by dbx-tools server and browser surfaces",
  );
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
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
  p.package.addField(
    "description",
    "Browser-safe Adaptive Card and Bot Framework activity schemas for the Teams add-on",
  );
  p.addDeps("zod@catalog:");
});

// shared-search: browser-safe zod wire contract for the AI Search add-on -
// the search request / hit / result shapes, the universal-search request, the
// document + upsert shapes, and the index-catalogue client config. Pure zod,
// shared by the server client, the Mastra tools, the routes, and the React
// search box.
project.applyToProjects(root, { identifierName: "shared-search", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe schemas and extension types for AppKit-compatible AI Search providers",
  );
  p.addDeps("zod@catalog:");
});

// shared-mastra: browser-safe wire contract + embed-marker grammar + route
// segments for the Mastra add-on's clientConfig surface. Pure zod; extends
// the genie + model wire schemas.
project.applyToProjects(root, { identifierName: "shared-mastra", tags: "shared" }, (p) => {
  p.package.addField("description", "Browser-safe contracts for the AppKit Mastra plugin");
  p.addDeps(
    "zod@catalog:",
    "@dbx-tools/shared-genie@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
  );
});

// shared-genie: browser-safe Genie wire contracts + the high-level chat event
// vocabulary and detectors. `src/dashboards.ts` is GENERATED here by the engine's
// synth-time codegen from the Databricks SDK `.d.ts` (the typed codegen input
// below names the source); `src/genie-model.ts` extends those schemas with the
// fields Genie ships on the wire that the SDK does not type yet.
//
// The generated schemas live HERE rather than in a package of their own: shared-genie
// is their only consumer, both are zod-only browser-safe contracts, and the generator
// writes a generated module alongside hand-written ones without complaint. A separate
// package would buy a boundary and cost an extra hop for every Genie type. The SDK
// stays a devDep - codegen reads its declarations, nothing imports it at runtime.
project.applyToProjects(root, { identifierName: "shared-genie", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe Genie schemas, event vocabulary, and snapshot diff helpers",
  );
  p.addDeps("@dbx-tools/shared-core@workspace:^", "zod@catalog:");
  p.addDevDeps("@databricks/sdk-experimental@catalog:");
  p.dbxToolsConfig.codegenInputs.push(
    "node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts",
  );
});

// The projen engine (`@dbx-tools/projen`) lives in `projen/`, now a member of
// the single bun workspace (added via `extraWorkspaceMembers`). It synthesizes
// itself, so there is no engine rule here.

// cli-service: a product-agnostic systray host plus Commander lifecycle command.
// It remains public because consuming published CLIs load its compiled runtime;
// marking it private would leave those manifests with an unresolvable dependency.
project.applyToProjects(root, { identifierName: "cli-service", tags: "cli" }, (p) => {
  p.package.addField(
    "description",
    "Cross-platform service lifecycle, uv Python runtimes, and system tray menus for CLIs",
  );
  p.addDeps(
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    `bun@${bunWorkflow.BUN_VERSION}`,
    "systray2@catalog:",
  );
});

// Consolidated CLI. Feature command modules remain behind dynamic imports, so
// the single package does not eagerly load AppKit, Graphiti, tunnel, proxy, or
// model-gateway dependencies when another command is selected.
project.applyToProjects(root, { identifierName: "cli", tags: "cli" }, (p) => {
  p.package.addField(
    "description",
    "The dbx CLI for workspace lifecycle, AppKit environment, Databricks OAuth, and gated tunnels",
  );
  p.package.addBin({
    [SCOPE]: "./bin/dbx-tools.ts",
    dbx: "./bin/dbx-tools.ts",
    "dbx-graphiti": "./bin/dbx-graphiti.ts",
    "dbx-lakebase-proxy": "./bin/dbx-lakebase-proxy.ts",
    "dbx-model-gateway": "./bin/dbx-model-gateway.ts",
  });
  p.addDeps(
    "@clack/prompts@catalog:",
    "@databricks/appkit@catalog:",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/appkit-model-gateway@workspace:^",
    "@dbx-tools/auth@workspace:^",
    "@dbx-tools/auth-gate@workspace:^",
    "@dbx-tools/cli-service@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/databricks@workspace:^",
    "@dbx-tools/email@workspace:^",
    "@dbx-tools/graphiti@workspace:^",
    "@dbx-tools/lakebase@workspace:^",
    "@dbx-tools/postgres@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-email@workspace:^",
    "@dbx-tools/shared-model-gateway@workspace:^",
    "@dbx-tools/tunnel@workspace:^",
    "http-proxy-3@catalog:",
    "pg@^8.22.0",
  );
  p.addDevDeps("@types/pg@^8");
  project.addExports(p, {
    "./args": "./src/args.ts",
    "./appkit": "./src/appkit/cli.ts",
    "./appkit/env-export": "./src/appkit/env-export.ts",
    "./auth": "./src/auth/cli.ts",
    "./auth/options": "./src/auth/options.ts",
    "./graphiti": "./src/graphiti/cli.ts",
    "./graphiti/options": "./src/graphiti/options.ts",
    "./lakebase-proxy": "./src/lakebase-proxy/cli.ts",
    "./lakebase-proxy/options": "./src/lakebase-proxy/options.ts",
    "./model-gateway": "./src/model-gateway/cli.ts",
    "./model-gateway/server": "./src/model-gateway/server.ts",
    "./tunnel": "./src/tunnel/cli.ts",
    "./tunnel/options": "./src/tunnel/options.ts",
  });
});

// node-auth-gate: Better Auth runtime with email OTP, passkeys, caller-provided
// authorization/delivery, and Lakebase or SQLite persistence.
project.applyToProjects(root, { identifierName: "auth-gate", tags: "node" }, (p) => {
  p.package.addField(
    "description",
    "Passwordless authentication runtime built on Better Auth, email OTP, and passkeys",
  );
  p.addDeps(
    "@better-auth/passkey@catalog:",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/postgres@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "better-auth@catalog:",
    "env-paths@catalog:",
    "zod@catalog:",
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
  p.package.addField(
    "description",
    "In-process public Portr and FRP tunnels protected by the dbx-tools authentication gate",
  );
  p.addDeps(
    "@dbx-tools/auth-gate@workspace:^",
    "@dbx-tools/appkit@workspace:^",
    "@dbx-tools/core@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-auth@workspace:^",
    "@databricks/appkit@catalog:",
    "@types/express@catalog:",
    "better-call@catalog:",
    "http-proxy-3@catalog:",
    "zod@catalog:",
  );
  p.addDevDeps(`@types/bun@${bunWorkflow.BUN_VERSION}`);
  if (p instanceof project.DBXToolsTypeScriptProject && p.tsconfig) {
    new javascript.TypescriptConfig(p, {
      fileName: "assets/tsconfig.json",
      extends: javascript.TypescriptConfigExtends.fromTypescriptConfigs([p.tsconfig]),
      compilerOptions: {
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        noEmit: true,
        target: "ESNext",
        types: ["node", "bun"],
      },
      include: ["*.ts"],
    });
  }
  p.tasks.tryFind("pre-compile")?.exec("bunx tsc --build assets/tsconfig.json");
  p.tasks.tryFind("pre-compile")?.exec("bun assets/build-login-client.ts");
  // `@dbx-tools/email` is OPTIONAL: only the OTP gate's code delivery needs it, and
  // it is imported LAZILY (`send-code.ts`). A tunnel used without the gate (or in
  // `--insecure` mode) needs no mail transport, so it is an optional peer rather
  // than a hard dep; the app that mounts `authGate` provides it. Kept as a devDep
  // so it resolves for this package's own tests.
  projectJs.addOptionalPeer(p, "@dbx-tools/email@workspace:^");
});

// Common AppKit UI package. Foundation, branding, auth, email, and search stay
// tree-shakeable behind distinct subpath exports; Mastra and Teams remain
// separate packages because they carry larger optional dependency families.
project.applyToProjects(root, { identifierName: "ui", tags: "ui" }, (p) => {
  p.package.addField(
    "description",
    "AppKit React foundation with branding, authentication, email, and search surfaces",
  );
  p.addDeps(
    "@databricks/appkit-ui@catalog:",
    "@dbx-tools/shared-auth@workspace:^",
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-email@workspace:^",
    "@dbx-tools/shared-email-template@workspace:^",
    "@dbx-tools/shared-search@workspace:^",
    "lucide-react@catalog:",
    "tailwindcss@catalog:",
    "streamdown@catalog:",
  );
  project.addExports(p, {
    "./branding/react": "./src/branding/react/index.ts",
    "./branding/browser": "./src/branding/browser.ts",
    "./branding/assets": "./src/branding/generated/assets.ts",
    "./branding/styles.css": "./src/branding/styles.css",
    "./branding/brand-bridge.css": "./src/branding/brand-bridge.css",
    "./branding/assets/icon-light.svg": "./src/branding/generated/icon-light.svg",
    "./branding/assets/icon-dark.svg": "./src/branding/generated/icon-dark.svg",
    "./branding/assets/logo-light.svg": "./src/branding/generated/logo-light.svg",
    "./branding/assets/logo-dark.svg": "./src/branding/generated/logo-dark.svg",
    "./auth/react": "./src/auth/react/index.ts",
    "./email/react": "./src/email/react/index.ts",
    "./email/styles.css": "./src/email/styles.css",
    "./search/react": "./src/search/react/index.ts",
    "./search/styles.css": "./src/search/styles.css",
  });
  p.tasks.tryFind("pre-compile")?.exec("bun ../../../../branding/generate-package-assets.mjs");
});

// shared-auth: browser-safe passwordless and Databricks authentication schemas.
project.applyToProjects(root, { identifierName: "shared-auth", tags: "shared" }, (p) => {
  p.package.addField(
    "description",
    "Browser-safe passwordless and Databricks authentication schemas and types",
  );
  p.addDeps(
    "@better-auth/passkey@catalog:",
    "@dbx-tools/shared-core@workspace:^",
    "@simplewebauthn/browser@catalog:",
    "better-auth@catalog:",
    "zod@catalog:",
  );
});

// ui-teams: the React surface for the Teams add-on - an `AdaptiveCardView` that
// renders a compiled Adaptive Card with the `adaptivecards` JavaScript renderer,
// and a self-contained `AdaptiveCardGallery` dev tool that edits a `CardSpec`,
// compiles it through the server's `/api/teams/card` route, and previews the
// card live. Consumes the browser-safe shared-teams contract and renders
// through ui-appkit's UI kit. `ui`-tagged (React + jsx from the ui tag).
project.applyToProjects(root, { identifierName: "ui-teams", tags: "ui" }, (p) => {
  p.package.addField(
    "description",
    "React renderer for Microsoft Teams Adaptive Cards and Teams chat surfaces",
  );
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-teams@workspace:^",
    "@dbx-tools/ui@workspace:^",
    "adaptivecards@catalog:",
    // The `adaptivecards` renderer ships no markdown parser - a `TextBlock` is
    // markdown per the spec, but the host supplies the implementation - so the
    // card view installs `marked` as its `onProcessMarkdown` processor.
    "marked@catalog:",
  );
  // exports: `./react` + `./styles.css` + `./package.json` come from the `ui`
  // tag's component-library default.
});

// ui-mastra: the full Mastra chat UI - the self-contained `MastraChat`
// drop-in and its `useMastraChat` driver, the controlled `ChatView` shell, the
// `MastraPluginClient` + hooks (model catalogue, native memory paging, suggestions,
// inline chart/statement embeds), markdown + data-grid + chart rendering, and
// conversation-thread management. Consumes the browser-safe wire contracts
// (shared-mastra/genie/model) and renders through ui-appkit's UI kit. `ui`-tagged.
project.applyToProjects(root, { identifierName: "ui-mastra", tags: "ui" }, (p) => {
  p.package.addField("description", "React chat UI for the AppKit-Mastra plugin");
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/shared-mastra@workspace:^",
    "@dbx-tools/shared-genie@workspace:^",
    "@dbx-tools/shared-model@workspace:^",
    "@dbx-tools/ui@workspace:^",
    "@mastra/client-js@catalog:",
    // Native persisted-message conversion used by browser history hydration.
    "@mastra/core@catalog:",
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
// `@dbx-tools/*` packages as `workspace:^` source siblings rather than from the
// registry, so editing a package is reflected immediately.

// packages/example/server/appkit-demo: the AppKit server. `server` tag supplies
// express + the `bun --watch`/`bun` dev/start tasks.
project.applyToProjects(
  root,
  { path: "packages/example/server/appkit-demo", tags: "server" },
  (p) => {
    // A private runnable app, not an importable library: entry is `src/server.ts`.
    p.package.addField("private", true);
    p.package.addField("exports", { "./package.json": "./package.json" });
    projectJs.applyCompilerOptions(p, { rootDir: "." });
    projectJs.applyIncludes(p, "stage-deploy.ts");
    p.addDeps(
      "@dbx-tools/appkit@workspace:^",
      "@dbx-tools/graphiti@workspace:^",
      "@dbx-tools/appkit-mastra@workspace:^",
      "@dbx-tools/core@workspace:^",
      "@dbx-tools/databricks@workspace:^",
      "@dbx-tools/postgres@workspace:^",
      "@dbx-tools/email@workspace:^",
      "@dbx-tools/appkit-web-search@workspace:^",
      "@dbx-tools/teams@workspace:^",
      "@dbx-tools/search@workspace:^",
      "@dbx-tools/shared-core@workspace:^",
      // The tunnel library: the server registers `tunnelInterceptor()` on its own
      // `createApp` (public portr tunnel + Better Auth gate), so the deployed app.yaml
      // runs the server directly rather than through a wrapper bin.
      "@dbx-tools/tunnel@workspace:^",
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
      "yaml@^2.9.0",
    );
    p.addDevDeps(
      "@dbx-tools/projen@workspace:^",
      "@types/compression@^1.8.1",
      "@types/pg@^8",
      "@types/json-schema@^7",
    );
  },
);

// packages/example/app/appkit-demo: the React client. `app` tag supplies react +
// the bun dev server / `bun build` (Tailwind via bun-plugin-tailwind).
project.applyToProjects(root, { path: "packages/example/app/appkit-demo", tags: "app" }, (p) => {
  p.package.addField("private", true);
  p.addDeps(
    "@dbx-tools/shared-core@workspace:^",
    "@dbx-tools/ui@workspace:^",
    "@dbx-tools/ui-mastra@workspace:^",
    "@dbx-tools/ui-teams@workspace:^",
    "react-router-dom@catalog:",
    // `src/index.css` `@import`s these directly, so the app declares them.
    "@databricks/appkit-ui@catalog:",
    "tw-animate-css@catalog:",
    "tailwindcss@catalog:",
  );
});

// ---------------------------------------------------------------------------
// Python uv workspace
// ---------------------------------------------------------------------------
const pythonPackages: project.PythonPackageOptions[] = [
  {
    directory: "node-runtime",
    description: "Shared PythonMonkey runtime and lazy Node.js bootstrap",
    dependencies: ["databricks-sdk>=0.40,<1"],
    nodeRuntime: true,
    scripts: {
      "dbx-tools-node-runtime": "dbx_tools.node_runtime.__main__:main",
    },
  },
  {
    directory: "graphiti",
    description: "Unified Graphiti REST, MCP, model routing, and PostgreSQL graph runtime",
    dependencies: [
      "asyncpg>=0.30,<1",
      "fastapi>=0.115,<1",
      "graphiti-core==0.30.2",
      "httpx>=0.28,<1",
      "mcp>=2,<3",
      "openai>=2.41,<3",
      "platformdirs>=4,<5",
      "post-graph>=0.7,<1",
      "pydantic-settings>=2,<3",
      "pyyaml>=6,<7",
      "typing-extensions>=4,<5",
      "uvicorn>=0.44",
    ],
    optionalDependencies: {
      dev: ["embedded-postgres>=18.6.3,<19"],
    },
    sync: [
      {
        name: "postgraph",
        source:
          "postgraph-driver @ git+https://github.com/crajah/graphiti.git@4f6d7bc31dd9a84053d4094b382485044448d9c8#subdirectory=graphiti_core/driver",
        include: ["postgraph_driver.py", "record_parsers.py", "postgraph/**/*.py"],
        replace: {
          "import asyncio\n": "",
          "from contextlib import asynccontextmanager, suppress":
            "from contextlib import asynccontextmanager",
          "GraphProvider.POSTGRAPH": '"postgraph"',
          "        embedding_dim: int | None = None,\n    ):":
            "        embedding_dim: int | None = None,\n        connection_options: dict[str, Any] | None = None,\n    ):",
          "        self._embedding_dim = embedding_dim or EMBEDDING_DIM":
            "        self._embedding_dim = embedding_dim or EMBEDDING_DIM\n        self._connection_options = connection_options or {}",
          "            self._client = AsyncPostGraph(dsn=self._dsn)":
            "            self._client = AsyncPostGraph(dsn=self._dsn, **self._connection_options)",
          "        self._init_task: asyncio.Task | None = None\n        try:\n            loop = asyncio.get_running_loop()\n            self._init_task = loop.create_task(self._init())\n        except RuntimeError:\n            pass\n\n    async def _init(self):\n        await self._ensure_client()\n        await self.build_indices_and_constraints()\n\n":
            "",
          "        if self._init_task is not None and not self._init_task.done():\n            self._init_task.cancel()\n            with suppress(asyncio.CancelledError):\n                await self._init_task\n":
            "",
          "with suppress(TableExistsError, Exception):": "with suppress(TableExistsError):",
          "        for stmt in _tsvector_ddl():\n            with suppress(Exception):\n                await client._execute(stmt)":
            "        for stmt in _tsvector_ddl():\n            await client._execute(stmt)",
          "        for stmt in _extra_index_ddl():\n            with suppress(Exception):\n                await client._execute(stmt)":
            "        for stmt in _extra_index_ddl():\n            await client._execute(stmt)",
        },
      },
      {
        name: "graphiti_server",
        source: `graph-service @ git+https://github.com/getzep/graphiti.git@${GRAPHITI_UPSTREAM_COMMIT}#subdirectory=server`,
        include: ["graph_service/**/*.py"],
      },
      {
        name: "graphiti_mcp",
        source: `mcp-server @ git+https://github.com/getzep/graphiti.git@${GRAPHITI_UPSTREAM_COMMIT}#subdirectory=mcp_server/src`,
        include: [
          "graphiti_mcp_server.py",
          "config/**/*.py",
          "models/**/*.py",
          "services/**/*.py",
          "utils/**/*.py",
        ],
        replace: {
          "        self._queue_workers: dict[str, bool] = {}\n        # Store the graphiti client after initialization":
            "        self._queue_workers: dict[str, bool] = {}\n        self._worker_tasks: dict[str, asyncio.Task[None]] = {}\n        self._queue_errors: dict[str, list[Exception]] = {}\n        # Store the graphiti client after initialization",
          "            asyncio.create_task(self._process_episode_queue(group_id))":
            "            self._worker_tasks[group_id] = asyncio.create_task(self._process_episode_queue(group_id))",
          "                    logger.error(\n                        f'Error processing queued episode for group_id {group_id}: {str(e)}'\n                    )":
            "                    logger.error(\n                        f'Error processing queued episode for group_id {group_id}: {str(e)}'\n                    )\n                    self._queue_errors.setdefault(group_id, []).append(e)",
          "            self._queue_workers[group_id] = False\n            logger.info(f'Stopped episode queue worker for group_id: {group_id}')":
            "            self._queue_workers[group_id] = False\n            self._worker_tasks.pop(group_id, None)\n            logger.info(f'Stopped episode queue worker for group_id: {group_id}')",
          "    def get_queue_size(self, group_id: str) -> int:\n":
            "    async def wait_until_idle(self, group_id: str | None = None) -> None:\n        \"\"\"Wait until queued and in-flight episode work completes.\"\"\"\n        group_ids = (\n            [group_id]\n            if group_id is not None and group_id in self._episode_queues\n            else list(self._episode_queues)\n            if group_id is None\n            else []\n        )\n        await asyncio.gather(*(self._episode_queues[key].join() for key in group_ids))\n        errors = [\n            error\n            for key in group_ids\n            for error in self._queue_errors.pop(key, [])\n        ]\n        if errors:\n            raise RuntimeError(f'Queued episode processing failed: {errors[0]}') from errors[0]\n\n    async def close(self) -> None:\n        \"\"\"Drain episode work and stop idle queue workers.\"\"\"\n        error: Exception | None = None\n        try:\n            await self.wait_until_idle()\n        except Exception as caught:\n            error = caught\n        tasks = list(self._worker_tasks.values())\n        for task in tasks:\n            task.cancel()\n        if tasks:\n            await asyncio.gather(*tasks, return_exceptions=True)\n        self._worker_tasks.clear()\n        self._queue_workers.clear()\n        self._queue_errors.clear()\n        if error is not None:\n            raise error\n\n    def get_queue_size(self, group_id: str) -> int:\n",
          "uuid (str, optional): Optional UUID for the episode":
            "uuid (str, optional): UUID of an existing episode to update; omit it to create a new episode",
        },
      },
    ],
    nodeBindings: [
      {
        package: "@dbx-tools/shared-core",
        modules: ["bindings"],
      },
      {
        package: "@dbx-tools/shared-model",
      },
      {
        package: "@dbx-tools/shared-graphiti",
      },
      {
        package: "@dbx-tools/auth",
        modules: ["bindings"],
      },
      {
        package: "@dbx-tools/model",
        modules: ["bindings"],
      },
      {
        package: "@dbx-tools/lakebase",
        modules: ["bindings"],
      },
      {
        package: "@dbx-tools/postgres",
        modules: ["bindings"],
      },
    ],
  },
];

new project.DBXToolsPythonWorkspace(root, {
  root: PYTHON_ROOT,
  packages: pythonPackages,
  dependencies: ["dbx-tools-graphiti"],
  devDependencies: [
    "nodejs-wheel>=22.20,<23",
    "pythonmonkey==1.3.2",
    "tomli>=2,<3; python_version < '3.11'",
  ],
  requiresPython: ">=3.10,<4",
  ruffTarget: "py310",
  workflowPythonVersion: "3.10",
  // This workspace uses two trusted corporate indexes. The first can lag the
  // local devpi index, so uv must consider the pinned version from both.
  indexStrategy: "unsafe-best-match",
  lintPaths: ["packages/py"],
  release: true,
});
root.testTask.spawn(root.tasks.tryFind("py:lint")!);
root.tasks.tryFind("test:all")?.spawn(root.tasks.tryFind("py:test")!);
new BrandPackageAssets(root);

// ---------------------------------------------------------------------------
// Root development commands
// ---------------------------------------------------------------------------
// These commands orchestrate repository-wide development flows. Capability
// generation and package servers remain tasks on the package that owns them.

// In-repo runners for the CLI, mirroring the two bins the published
// `@dbx-tools/cli` installs (`dbx-tools` + the short `dbx` alias). bun runs the
// `.ts` entry directly.
for (const task of [SCOPE, "dbx"]) {
  const command = "bun packages/js/cli/dbx-tools/bin/dbx-tools.ts";
  root.addTask(task, {
    exec: command,
    receiveArgs: true,
  });
  root.setScript(task, command);
}

// Build the demo client, then run the AppKit server with the shared local
// environment. Both JavaScript apps are workspace members, so there is no nested
// projen synth or registry install.
// `.env` is the committed-shape local secret file; `.env.local` optionally
// overlays it. Both `--env-file` flags are missing-file tolerant under bun, so
// a laptop with only `.env` still supplies the email plugin's SMTP settings.
root.addTask("demo", {
  env: {
    NODE_ENV: "development",
    BUN_CONFIG_ELIDE_LINES: "0",
  },
  exec: "bun scripts/run-demo.ts",
  description: "Build the demo client and run the local AppKit server",
});

// The generated release workflow publishes every npm workspace member,
// including `@dbx-tools/projen`.

root.synth();
