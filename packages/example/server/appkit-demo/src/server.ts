import path from "node:path";
import { genie, lakebase, server } from "@databricks/appkit";
import { aiSearch } from "@databricks/appkit/beta";
import { appkit, telemetry as appkitTelemetry } from "@dbx-tools/appkit";
import { filesCache } from "@dbx-tools/appkit/files-cache";
import { AppKitLakeboxPlugin, lakebox, LakeboxRuntime } from "@dbx-tools/appkit-lakebox";
import { resolveLakeboxPluginConfig } from "@dbx-tools/appkit-lakebox/config";
import { lakeboxSkillMounts } from "@dbx-tools/appkit-lakebox/skills";
import {
  agents,
  genie as appkitMastraGenie,
  mastra,
  type MastraAgentDefinition,
  type MastraTools,
} from "@dbx-tools/appkit-mastra";
import { memory } from "@dbx-tools/appkit-memory";
import { webSearch } from "@dbx-tools/appkit-web-search";
import { configUtils, projectUtils } from "@dbx-tools/core";
import { defaultEmailBrand, email, emailTool } from "@dbx-tools/email";
import { postgresConnectionOptions } from "@dbx-tools/postgres";
import { lakebaseAiSearch, search } from "@dbx-tools/search";
import { brandUtils } from "@dbx-tools/shared-core";
import { authGate, tunnelInterceptor } from "@dbx-tools/tunnel";
import { z } from "zod";

import {
  createClientDevelopmentProxy,
  type ClientDevelopmentProxy,
} from "./_client-development.ts";
import { configureStaticDelivery } from "./_static-delivery.ts";
import { busDemo } from "./bus-demo.ts";

/**
 * Drop one-line HTTP access logs (`[16:50:31] GET /path → 200`).
 * Vite `logLevel: "silent"` and AppKit `telemetry.traces: false` do not
 * suppress this stream; it is written as raw console/stdout lines.
 */
function silenceHttpAccessLogs(): void {
  const ansi = /\u001b\[[0-9;]*m/g;
  const access =
    /^\[[0-2]\d:[0-5]\d:[0-5]\d\] (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) .+ → \d{3}\s*$/;
  const skip = (value: string): boolean => access.test(value.replace(ansi, "").trim());
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string" && skip(args[0])) return;
    originalLog(...args);
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: () => void,
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    const lines = text.split(/\r?\n/);
    const meaningful = lines.filter((line, index) => {
      if (line === "" && index === lines.length - 1) return false;
      return true;
    });
    if (meaningful.length > 0 && meaningful.every(skip)) return true;
    return originalWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;
}

silenceHttpAccessLogs();

const SEARCH_ALIAS = "docs";
const SEARCH_COLUMNS = ["id", "title", "text", "url"];
const SEARCH_INDEX = process.env.SEARCH_INDEX;
const USE_VECTOR_SEARCH = Boolean(process.env.SEARCH_ENDPOINT);
const searchIndexName = SEARCH_INDEX ?? SEARCH_ALIAS;
const SEARCH_DOCUMENTS = [
  {
    id: "1",
    title: "Build governed Mastra agents in Databricks Apps",
    text: "Register a Mastra agent with AppKit, stream tool calls, require approval for external actions, persist conversation threads, and capture MLflow feedback in one chat surface.",
    url: "https://dbx.tools/guides/agents-and-genie/#register-a-mastra-agent",
  },
  {
    id: "2",
    title: "Use direct AI/BI Genie conversations",
    text: "Serve a Genie space directly through the same chat UI while Genie owns conversation history, SQL reasoning, citations, tables, and native visualizations.",
    url: "https://dbx.tools/guides/agents-and-genie/#render-direct-genie-chat",
  },
  {
    id: "3",
    title: "Render a production-ready agent chat",
    text: "Add persistent threads, model selection, exports, tool progress, approvals, charts, tables, attachments, and feedback without assembling a second chat framework.",
    url: "https://dbx.tools/guides/agents-and-genie/#render-mastra-chat",
  },
  {
    id: "4",
    title: "Give every user a persistent Lakebox workspace",
    text: "Expose a browser terminal, desktop, persistent home, isolated services, and live machine metrics from one app-owned Databricks Lakebox.",
    url: "https://dbx.tools/packages/appkit-lakebox/#register-the-plugin",
  },
  {
    id: "5",
    title: "Deploy a self-contained 3D Lakebox scene",
    text: "Use the Lakebox showcase skill to create a polished browser-only 3D dog or interactive scene, package it in a small OCI service, and route it through the app.",
    url: "https://dbx.tools/packages/appkit-lakebox/#create-a-service",
  },
  {
    id: "6",
    title: "Deploy an MS Paint-style browser app",
    text: "Create a retro paint or pixel editor as a self-contained HTML application, keep all assets inline, and deploy it as a user-scoped Lakebox service.",
    url: "https://dbx.tools/packages/appkit-lakebox/#create-a-service",
  },
  {
    id: "7",
    title: "Deploy a platformer or arcade game",
    text: "Generate a one-port browser platformer, puzzle, or arcade game and let an agent deploy, inspect, restart, and remove it through governed Lakebox tools.",
    url: "https://dbx.tools/packages/appkit-lakebox/#create-a-service",
  },
  {
    id: "8",
    title: "Choose AI Search or Lakebase full-text search",
    text: "Use one browser and agent search contract with managed Databricks Vector Search in production or Lakebase full-text search for a simple local and demo path.",
    url: "https://dbx.tools/packages/search/#choose-a-search-provider",
  },
  {
    id: "9",
    title: "Search every configured index",
    text: "Universal search fans one query across configured indexes, merges scored hits, and preserves each result's source so applications can search multiple governed domains.",
    url: "https://dbx.tools/packages/search/#add-search-to-a-mastra-agent",
  },
  {
    id: "10",
    title: "Ground a Mastra agent with the same search indexes",
    text: "Expose the application's configured AI Search indexes as agent tools so a model can retrieve governed records before it answers or requests an action.",
    url: "https://dbx.tools/packages/search/#add-search-to-a-mastra-agent",
  },
  {
    id: "11",
    title: "Broadcast live progress with the Postgres message bus",
    text: "Use typed Lakebase or PostgreSQL topics to broadcast workflow completion, agent progress, cache invalidation, and operator events across app replicas and browser sessions.",
    url: "https://dbx.tools/packages/postgres/#topic-bus",
  },
  {
    id: "12",
    title: "Replay persisted messages after reconnect",
    text: "Persist selected topic messages so a reconnecting viewer can catch up before switching back to low-latency LISTEN and NOTIFY delivery.",
    url: "https://dbx.tools/packages/postgres/#replay-with-persist",
  },
  {
    id: "13",
    title: "Apply one brand across the app and email",
    text: "Drive application tokens, browser metadata, icons, authentication surfaces, email chrome, and delivered React Email messages from one typed brand context.",
    url: "https://dbx.tools/packages/ui/#branding",
  },
  {
    id: "14",
    title: "Preview approval-gated email before delivery",
    text: "Render recipient fields, subject, attachments, sender icon, and the exact branded message body before a person approves the external action.",
    url: "https://dbx.tools/packages/ui/#email",
  },
  {
    id: "15",
    title: "Add memory, search, and approved actions",
    text: "Combine managed memory, governed retrieval, web research, and approval-gated email into a Databricks app agent without duplicating identity or persistence policy.",
    url: "https://dbx.tools/guides/memory-search-and-actions/",
  },
];

const { createAgent, createTool, tool } = agents;
const { GENIE_INSTRUCTIONS } = appkitMastraGenie;
const { defaultBrandContext } = brandUtils;
const mastraStorage =
  configUtils.boolean(undefined, "MASTRA_STORAGE", configUtils.ENV_ONLY) ?? true;
const mastraMemory = configUtils.boolean(undefined, "MASTRA_MEMORY", configUtils.ENV_ONLY) ?? true;
const databricksMemoryEnabled = configUtils.boolean(undefined, "MANAGED_MEMORY", {
  sources: "env",
});
const databricksMemoryStore = process.env.DATABRICKS_AGENT_MEMORY_STORE_ID?.trim();
const databricksMemory =
  databricksMemoryEnabled === false
    ? false
    : databricksMemoryStore
      ? {
          memoryStore: databricksMemoryStore,
          mode: databricksMemoryEnabled === true ? ("required" as const) : ("auto" as const),
        }
      : (databricksMemoryEnabled ?? "auto");
const graphitiEnabled =
  configUtils.boolean(undefined, "GRAPHITI_ENABLED", configUtils.ENV_ONLY) ?? true;
const memorySaveTurns = configUtils.boolean(undefined, "MEMORY_SAVE_TURNS", configUtils.ENV_ONLY);
const busEnabled = configUtils.boolean(undefined, "BUS_ENABLED", configUtils.ENV_ONLY) ?? true;
const remoteSkillsEnabled =
  configUtils.boolean(undefined, "REMOTE_SKILLS_ENABLED", configUtils.ENV_ONLY) ?? true;
const appkitBodyLimit =
  configUtils.string(undefined, "APPKIT_BODY_LIMIT", { sources: "env" }) ?? "100mb";
const lakeboxRuntime = new LakeboxRuntime(resolveLakeboxPluginConfig());

// The browser bundle built by the sibling `@dbx-tools/demo-appkit-app` package.
// `server({ staticPath })` serves it on the same port as the API. Locally the
// bundle lives beside the sibling package; a deployed Databricks App instead
// stages it into the app root and points here with `CLIENT_DIST`, since the
// sibling path does not exist in the deployed tree.
const clientDist =
  process.env.CLIENT_DIST ??
  path.resolve(projectUtils.root() ?? process.cwd(), "packages/example/app/appkit-demo/dist");
const demoClientRoot = path.resolve(
  projectUtils.root() ?? process.cwd(),
  "packages/example/app/appkit-demo",
);
const clientDevUrl = configUtils.string(undefined, "CLIENT_DEV_URL", configUtils.ENV_ONLY);
/** AppKit `server()` runs Vite middleware HMR when `staticPath` is omitted. */
const useAppKitVite = process.env.NODE_ENV === "development" && !clientDevUrl;
let clientDevelopmentProxy: ClientDevelopmentProxy | undefined;
let appServer: { getServer(): import("node:http").Server } | undefined;

// AppKit demo wiring for `@dbx-tools/appkit-mastra`.
//
// `appkit.createApp` here is the auto-configuring wrapper from
// `@dbx-tools/appkit`, not AppKit's own. Because a `lakebase()`
// plugin is in the list, it runs `autopg()` BEFORE delegating to
// AppKit's `createApp` - resolving LAKEBASE_ENDPOINT / PGHOST /
// PGDATABASE via the Databricks Postgres REST API and writing them to
// `process.env` so the lakebase plugin sees a fully-populated env. This
// runs up front (not as a plugin) because AppKit's plugin phases only
// order `setup()` invocation, not async completion, so a plugin would
// race lakebase's synchronous env validation.
//
// Plugin order:
// 1. `server()`, `lakebase()`, and `filesCache()` register before `mastra()`
//    so Mastra can discover the process-local user-scoped filesystem cache
//    and initialize Lakebase-backed memory during setup.
// 2. `mastra(...)` mounts a chat route per registered agent under
//    `/api/mastra/route/chat/<agentId>` (plus `/route/chat` bound to
//    the default). Each agent resolves its model from the workspace
//    `/serving-endpoints` with user-scoped auth (`asUser(req)`).
// 3. `lakebase()` backs Mastra Memory (`PostgresStore` + `PgVector`)
//    when `storage` / `memory` are true on the mastra plugin.
//
// Genie integration: register the AppKit `genie()` plugin for its resource
// manifest and `spaces` config format. The deployed binding lives in
// `databricks.yml`. The `mastra()` plugin's
// `plugins.genie?.toolkit()` callback returns a flat set of Genie
// tools (`ask_genie`, `get_statement`, `prepare_chart`,
// `get_space_description`, `get_space_serialized`) the central
// agent drives directly. The tools talk to Genie via
// `@dbx-tools/genie` for streaming + `getStatement`-backed row
// hydration; no inner Genie orchestrator agent.
//
// Workspace capabilities: `createAgent` defaults `workspace` to
// `databricksWorkspace()`, which provides file access, configured Assistant
// skill paths, and Monty command execution. Each capability can be configured
// or disabled independently. Code Mode uses its own isolated-vm or QuickJS
// transport rather than the workspace command sandbox.
//
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME - optional override; when absent the
//   highest-ranked available live endpoint is selected
// - LAKEBASE_PROJECT (or LAKEBASE_ENDPOINT) - autopg fills in the rest
// - DATABRICKS_GENIE_SPACE_ID - picked up by `genie()` as the
//   `default` space when `spaces` is omitted.

// Agents are declared the same way as AppKit's `agents` plugin:
// build each definition with `createAgent({...})` (typed request context plus
// the default workspace), then hand it to `mastra({ agents })`.
//
// `agents` accepts three shapes for convenience:
//   - record:  `{ support: def, helper: def }`
//   - array:   `[def1, def2]`            (first becomes the default)
//   - single:  `def`                     (becomes the default)
//
// The `tools(plugins)` callback receives a typed plugin index that
// auto-discovers any registered AppKit `ToolProvider` plugin
// (`analytics`, `files`, `lakebase`, `genie`, ...). Unknown
// names return `undefined` so it's safe to guard with `?.`.
//
// `model` falls back to `DATABRICKS_SERVING_ENDPOINT_NAME`, then to the
// highest-ranked endpoint in the workspace's live `/serving-endpoints` list
// (cached for 5 min). Loose configured values like `"claude sonnet"` are
// fuzzy-matched to the real endpoint name.
// Per-request overrides via `X-Mastra-Model` header, `?model=` query,
// or body `model` field can re-target the same agent without redeploy.
// `GET /api/mastra/models` lists the cached catalogue.
const DemoRequestContextSchema = z.object({
  route: z.string().optional(),
  surface: z.string().optional(),
  storeId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
type DemoRequestContext = z.infer<typeof DemoRequestContextSchema>;

function buildSupportDefinition(): MastraAgentDefinition<DemoRequestContext> {
  const baseInstructions = [
    "You are a data analyst helping customers explore a Databricks",
    "Genie space. Default to driving the Genie tools (`ask_genie`,",
    "`get_statement`, `prepare_chart`, `get_space_description`,",
    "`get_space_serialized`) below - they are the only way to see",
    "the real data, so use them whenever the user's question is",
    "about the data the space covers. Reserve direct (no-tool)",
    "answers for pure meta-questions about your own behaviour or",
    "the conversation itself.",
    "Durable memory tools are also available. Use them when the user",
    "asks to save or retrieve durable knowledge and preferences.",
    "",
    GENIE_INSTRUCTIONS,
  ].join("\n");
  return {
    name: "Support",
    requestContextSchema: DemoRequestContextSchema,
    instructions: ({ requestContext }) => {
      const applicationContext = requestContext.all;
      const context =
        Object.keys(applicationContext).length > 0
          ? `Current application context:\n${JSON.stringify(applicationContext, null, 2)}`
          : "No application context was supplied for this turn.";
      return `${baseInstructions}\n\n${context}`;
    },
    async tools(plugins): Promise<MastraTools> {
      // Materialize the selected Genie toolkit before adding the demo tools.
      // Building one contextually-typed object makes TypeScript recursively
      // expand every source-linked Mastra tool schema together and exceeds its
      // instantiation depth; Object.assign preserves the same flat runtime
      // record without forcing that useless cross-tool type expansion.
      const agentTools = Object.assign({}, (await plugins.genie?.toolkit()) ?? {}) as MastraTools;
      Object.assign(agentTools, await plugins.memory?.toolkit());
      Object.assign(agentTools, await plugins[AppKitLakeboxPlugin.manifest.name]?.toolkit());
      Object.assign(agentTools, await plugins["web-search"]?.toolkit({ prefix: "" }));
      Object.assign(agentTools, await plugins.search?.toolkit({ prefix: "" }));
      Object.assign(agentTools, {
        // Auto-discovered AppKit `ToolProvider` plugins. `plugins.<name>`
        // is `undefined` when the plugin isn't registered, so the `?.`
        // guard keeps this safe to copy into other apps.
        // Spread other toolkits once registered (uncomment alongside
        // adding `analytics()` / `files()` to the plugin list below):
        // ...plugins.analytics.toolkit(),
        // ...plugins.files.toolkit({ only: ["uploads.read"] }),
        get_weather: tool({
          description: "Weather",
          schema: z.object({ city: z.string() }),
          execute: async ({ city }) => `Sunny in ${city}`,
        }),
        get_ui_context: createTool({
          id: "get_ui_context",
          description: "Return the route and selected UI entity supplied for this turn.",
          inputSchema: z.object({}),
          outputSchema: DemoRequestContextSchema,
          requestContextSchema: DemoRequestContextSchema,
          execute: async (_input, context) => context.requestContext?.all ?? {},
        }),
        // Approval-gated email tool from `@dbx-tools/email`. The
        // model can call this freely; execution pauses until the user
        // clicks Approve in the chat UI, then the message is sent for
        // real over SMTP. The sender is derived from the on-behalf-of
        // user's email on the configured `EMAIL_DOMAIN` (system mail, like
        // the tunnel's sign-in code, uses `no-reply@` there instead); SMTP host /
        // credentials come from the `email()` plugin config / env.
        send_email: emailTool(),
      });
      return agentTools;
    },
  };
}
const support = createAgent<DemoRequestContext>(buildSupportDefinition());

const host = process.env.HOST ?? "127.0.0.1";

if (USE_VECTOR_SEARCH && !SEARCH_INDEX) {
  throw new Error("SEARCH_INDEX is required when SEARCH_ENDPOINT is set");
}

const searchProvider = USE_VECTOR_SEARCH
  ? aiSearch({
      indexes: {
        [SEARCH_ALIAS]: {
          indexName: searchIndexName,
          columns: SEARCH_COLUMNS,
          queryType: "hybrid",
          numResults: 12,
        },
      },
    })
  : lakebaseAiSearch({
      indexes: {
        [SEARCH_ALIAS]: {
          indexName: searchIndexName,
          columns: SEARCH_COLUMNS,
          queryType: "full_text",
          numResults: 12,
          documents: SEARCH_DOCUMENTS,
        },
      },
      ...(process.env.SEARCH_LAKEBASE_SCHEMA ? { schema: process.env.SEARCH_LAKEBASE_SCHEMA } : {}),
      allowWrite: true,
    });

const previousCwd = process.cwd();
if (useAppKitVite) process.chdir(demoClientRoot);
try {
  await appkitTelemetry.configureNativeHttpTelemetry({
    exclude: [lakeboxRuntime.config.routePrefix, `${lakeboxRuntime.config.routePrefix}/*`],
  });
  await appkit.createApp({
    disableInternalTelemetry: true,
    plugins: [
      // Keep AppKit's native HTTP/Express tracing. The compatibility hook above
      // only extends its request filter for long-lived Lakebox proxy traffic.
      server({
        host,
        bodyLimit: appkitBodyLimit,
        ...(useAppKitVite ? {} : { staticPath: clientDist }),
      }),
      genie(),
      lakebase({ pool: postgresConnectionOptions({}) }),
      filesCache(),
      lakebox({ runtime: lakeboxRuntime }),
      ...(graphitiEnabled || databricksMemory !== false
        ? [
            memory({
              databricks: databricksMemory,
              graphiti: graphitiEnabled,
              saveTurns: memorySaveTurns ?? "auto",
            }),
          ]
        : []),
      // Postgres LISTEN/NOTIFY demo. Every app instance listens on one dedicated
      // Lakebase connection and fans topic broadcasts out to its browser viewers.
      ...(busEnabled ? [busDemo()] : []),
      // Validates SMTP config + verifies connectivity at startup, and
      // primes the transport the approval-gated `send_email` tool reuses.
      // `brand` styles every rendered email (accent, font, header logo)
      // with the dbx-tools brand; drop it for the neutral default layout.
      email({ brand: defaultEmailBrand }),
      // The email-OTP access gate for the public portr tunnel. Registers the
      // `/api/email/auth/*` login routes + a gating middleware on THIS server that
      // gates only tunnel traffic (identified by the `Host` header matching
      // `TUNNEL_PUBLIC_DOMAIN`); the platform front door passes through. Lakebox
      // service routes also need the verified tunnel identity before their strict
      // user-hash check, so protect the runtime-owned route prefix rather than letting
      // those requests fall through to the SPA. `allow` comes from
      // `TUNNEL_AUTH_ALLOW`, `publicDomain` from `TUNNEL_PUBLIC_DOMAIN` (both set
      // on the deployed app). Codes send through the `email()` transport above.
      // Localhost gets an explicit disabled status because its Host header never
      // matches the tunnel domain.
      authGate({ gatePaths: [lakeboxRuntime.config.routePrefix] }),
      // Web-search runtime for the `web_search` / `web_fetch` tools. The
      // web-search model defaults to Gemini, then GPT (the native web-search
      // tool is provider-specific); set `model` / WEB_SEARCH_MODEL to pin one,
      // or `allowedUrls` to restrict which sites are reachable.
      webSearch(),
      searchProvider,
      // The provider registered above owns the AppKit AI Search query contract:
      // native `aiSearch` when SEARCH_ENDPOINT is configured, otherwise
      // `lakebaseAiSearch` over PostgreSQL full text. Both expose the same
      // `/api/ai-search/:alias/query` route and client config consumed by
      // AppKit's `useAiSearchQuery`.
      //
      // This `search` plugin adds agent tools, universal search, and index
      // lifecycle routes. On the native path, `ensureOnSetup` creates and seeds
      // the managed Vector Search index in the background. The Lakebase provider
      // provisions its own full-text table during setup.
      search({
        allowWrite: true,
        // Native Vector Search uses SEARCH_INDEX (catalog.schema.index). Lakebase
        // full-text search uses the `docs` alias as the table name when unset.
        index: searchIndexName,
        // The endpoint is used only by native Vector Search lifecycle operations.
        ...(process.env.SEARCH_ENDPOINT ? { endpoint: process.env.SEARCH_ENDPOINT } : {}),
        indexes: [{ name: searchIndexName, alias: SEARCH_ALIAS, columns: SEARCH_COLUMNS }],
        columns: SEARCH_COLUMNS,
        ...(USE_VECTOR_SEARCH ? { ensureOnSetup: { documents: SEARCH_DOCUMENTS } } : {}),
      }),
      mastra({
        storage: mastraStorage,
        memory: mastraMemory,
        // Fail boot unless MLFLOW_EXPERIMENT_ID or MLFLOW_EXPERIMENT_NAME is set.
        // The deployed app binds `/Shared/dbx-tools-demo` and the Apps OTLP sidecar.
        feedback: true,
        agents: { support },
        defaultAgent: "support",
        genieAgentMode: true,
        workspaceFallbackToTmp: true,
        // Chat runs on-behalf-of the signed-in user by default, so the caller must
        // be a workspace member. Set MASTRA_GENIE_IDENTITY=service-principal (or
        // genieIdentity: "service-principal" here) to run the agents' Databricks
        // calls as the app service principal instead, so any account user who can
        // open the app can chat even without workspace membership. The deployed
        // demo uses `auto`: the Databricks Apps front door supplies OBO credentials,
        // while the OTP tunnel supplies only caller identity and falls back to the
        // app service principal.
        // User attribution still partitions memory, cache, and traces.
        // Themes charts from the `render_data` / `prepare_chart` tools with the
        // same brand the client UI (`BrandProvider`) and email layouts use, so a
        // generated chart matches the surrounding AppKit UI instead of falling
        // back to Echarts' defaults.
        brand: defaultBrandContext,
        localSkillMounts: lakeboxSkillMounts(),
        // Fold Databricks' own AI Tools skills into the agents. Read straight
        // from the public databricks/databricks-agent-skills repo, so this works
        // in a deployed App container where the `databricks` CLI is absent.
        ...(remoteSkillsEnabled ? { remoteSkills: "aitools" as const } : {}),
      }),
    ],
    async onPluginsReady(appkit) {
      appServer = appkit.server;
      try {
        await appkit.search.addDocuments({ documents: SEARCH_DOCUMENTS });
      } catch (error) {
        console.warn("Demo search documents could not be refreshed", error);
      }
      if (clientDevUrl) {
        clientDevelopmentProxy = createClientDevelopmentProxy(clientDevUrl, appkit.authGate);
        appkit.server.extend(clientDevelopmentProxy.configure);
      }
      if (!useAppKitVite) {
        appkit.server.extend((application) => configureStaticDelivery(application, clientDist));
      }
    },
    // Front the app with a public portr tunnel IN-PROCESS: `tunnelInterceptor`
    // applies the computed DATABRICKS_HOST, launches portr pointed at this app's
    // public port, and binds it so the app and portr live/die as one. Without
    // PORTR_TOKEN and TUNNEL_PUBLIC_DOMAIN it remains inactive, while localhost
    // continues to bypass the host-scoped OTP gate.
    interceptor: tunnelInterceptor(),
    cache: {
      enabled: true,
    },
  });
} finally {
  if (useAppKitVite) process.chdir(previousCwd);
}

if (clientDevelopmentProxy && appServer) {
  clientDevelopmentProxy.attach(appServer.getServer());
}
