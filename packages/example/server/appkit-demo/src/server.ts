import path from "node:path";
import { genie, lakebase, server } from "@databricks/appkit";
import { aiSearch } from "@databricks/appkit/beta";
import { appkit } from "@dbx-tools/appkit";
import { filesCache } from "@dbx-tools/appkit/files-cache";
import { graphiti } from "@dbx-tools/appkit-graphiti";
import {
  agents,
  genie as appkitMastraGenie,
  mastra,
  type MastraAgentDefinition,
  type MastraPlugins,
  type MastraTools,
} from "@dbx-tools/appkit-mastra";
import { webSearch } from "@dbx-tools/appkit-web-search";
import { configUtils, projectUtils } from "@dbx-tools/core";
import { defaultEmailBrand, email, emailTool } from "@dbx-tools/email";
import { postgresConnectionOptions } from "@dbx-tools/postgres";
import { lakebaseAiSearch, search } from "@dbx-tools/search";
import { brandUtils } from "@dbx-tools/shared-core";
import { teams } from "@dbx-tools/teams";
import { authGate, tunnelInterceptor } from "@dbx-tools/tunnel";
import { z } from "zod";

import { configureStaticDelivery } from "./_static-delivery.ts";
import { busDemo } from "./bus-demo.ts";

/** Default search index used by both AppKit resource validation and the plugin. */
const DEFAULT_SEARCH_INDEX = "reggie_pierce_aws_catalog.ai_search.docs";
const SEARCH_ALIAS = "docs";
const SEARCH_COLUMNS = ["id", "title", "text", "url"];
const USE_VECTOR_SEARCH = Boolean(process.env.SEARCH_ENDPOINT);
const SEARCH_DOCUMENTS = [
  {
    id: "1",
    title: "Databricks AI Search overview",
    text: "AI Search (Vector Search) indexes documents and finds the most relevant ones for a query using hybrid semantic + keyword matching.",
    url: "https://docs.databricks.com/aws/en/generative-ai/vector-search",
  },
  {
    id: "2",
    title: "Delta Sync indexes",
    text: "A Delta Sync index computes embeddings from a source Delta table and keeps the index in sync as rows change.",
    url: "https://docs.databricks.com/aws/en/generative-ai/vector-search",
  },
  {
    id: "3",
    title: "Direct access indexes",
    text: "A direct-access index lets you upsert documents yourself; with managed embeddings Databricks embeds a text column on write and query.",
    url: "https://docs.databricks.com/aws/en/generative-ai/create-query-vector-search",
  },
  {
    id: "4",
    title: "Autocomplete and universal search",
    text: "Autocomplete is a small-limit search over one index; universal search fans a query across every configured index and merges the hits.",
    url: "https://docs.databricks.com/aws/en/generative-ai/vector-search",
  },
  {
    id: "5",
    title: "Unity Catalog governance",
    text: "Indexes are Unity Catalog objects, so search runs under the caller's identity and SELECT permissions on the index apply.",
    url: "https://docs.databricks.com/aws/en/data-governance/unity-catalog",
  },
];

const { createAgent, createTool, tool } = agents;
const { buildGenieTools, GENIE_INSTRUCTIONS } = appkitMastraGenie;
const { defaultBrandContext } = brandUtils;
const mastraStorage =
  configUtils.boolean(undefined, "MASTRA_STORAGE", configUtils.ENV_ONLY) ?? true;
const mastraMemory = configUtils.boolean(undefined, "MASTRA_MEMORY", configUtils.ENV_ONLY) ?? true;
const graphitiEnabled =
  configUtils.boolean(undefined, "GRAPHITI_ENABLED", configUtils.ENV_ONLY) ?? true;
const busEnabled = configUtils.boolean(undefined, "BUS_ENABLED", configUtils.ENV_ONLY) ?? true;
const remoteSkillsEnabled =
  configUtils.boolean(undefined, "REMOTE_SKILLS_ENABLED", configUtils.ENV_ONLY) ?? true;
const localDevelopment = process.env.NODE_ENV === "development";

// The browser bundle built by the sibling `@dbx-tools/demo-appkit-app` package.
// `server({ staticPath })` serves it on the same port as the API. Locally the
// bundle lives beside the sibling package; a deployed Databricks App instead
// stages it into the app root and points here with `CLIENT_DIST`, since the
// sibling path does not exist in the deployed tree.
const clientDist =
  process.env.CLIENT_DIST ??
  path.resolve(projectUtils.root() ?? process.cwd(), "packages/example/app/appkit-demo/dist");

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
// or disabled independently.
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
async function demoGenieTools(plugins: MastraPlugins, agentMode: boolean): Promise<MastraTools> {
  if (agentMode) return (await plugins.genie?.toolkit()) ?? {};

  const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
  if (!spaceId) {
    throw new Error("DATABRICKS_GENIE_SPACE_ID is required for the polling demo agent");
  }

  return buildGenieTools({
    spaces: { default: spaceId },
    config: { brand: defaultBrandContext, genieAgentMode: false },
  });
}

const DemoRequestContextSchema = z.object({
  route: z.string().optional(),
  surface: z.string().optional(),
  storeId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
type DemoRequestContext = z.infer<typeof DemoRequestContextSchema>;

function buildSupportDefinition(agentMode: boolean): MastraAgentDefinition<DemoRequestContext> {
  const baseInstructions = [
    "You are a data analyst helping customers explore a Databricks",
    "Genie space. Default to driving the Genie tools (`ask_genie`,",
    "`get_statement`, `prepare_chart`, `get_space_description`,",
    "`get_space_serialized`) below - they are the only way to see",
    "the real data, so use them whenever the user's question is",
    "about the data the space covers. Reserve direct (no-tool)",
    "answers for pure meta-questions about your own behaviour or",
    "the conversation itself.",
    "Graphiti memory tools are also available. Use them when the user",
    "asks to save, retrieve, or manage durable knowledge and preferences.",
    "",
    GENIE_INSTRUCTIONS,
  ].join("\n");
  return {
    name: agentMode ? "Support" : "Support (polling)",
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
      const agentTools = Object.assign({}, await demoGenieTools(plugins, agentMode)) as MastraTools;
      Object.assign(agentTools, await plugins.graphiti?.toolkit());
      Object.assign(agentTools, await plugins["web-search"]?.toolkit({ prefix: "" }));
      Object.assign(
        agentTools,
        await plugins.teams?.toolkit({
          prefix: "",
          rename: { createCard: "create_teams_card" },
        }),
      );
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
const support = createAgent<DemoRequestContext>(buildSupportDefinition(true));
const supportPolling = createAgent<DemoRequestContext>(buildSupportDefinition(false));

const host = process.env.HOST ?? "127.0.0.1";

// Keep the provider and extension plugin on the same resolved index value.
process.env.SEARCH_INDEX ??= DEFAULT_SEARCH_INDEX;
const searchProvider = USE_VECTOR_SEARCH
  ? aiSearch({
      indexes: {
        [SEARCH_ALIAS]: {
          indexName: process.env.SEARCH_INDEX,
          columns: SEARCH_COLUMNS,
          queryType: "hybrid",
          numResults: 10,
        },
      },
    })
  : lakebaseAiSearch({
      indexes: {
        [SEARCH_ALIAS]: {
          indexName: process.env.SEARCH_INDEX,
          columns: SEARCH_COLUMNS,
          queryType: "full_text",
          numResults: 10,
          documents: SEARCH_DOCUMENTS,
        },
      },
      ...(process.env.SEARCH_LAKEBASE_SCHEMA ? { schema: process.env.SEARCH_LAKEBASE_SCHEMA } : {}),
      allowWrite: true,
    });

await appkit.createApp({
  plugins: [
    // AppKit's server plugin enables HTTP/Express tracing by default whenever
    // an exporter is active. This demo wants agent traces, not one trace per
    // request; appkit-mastra creates a request-lifetime chat root when the HTTP
    // instrumentation is disabled.
    server({ host, staticPath: clientDist, telemetry: { traces: false } }),
    genie(),
    lakebase({ pool: postgresConnectionOptions({}) }),
    filesCache(),
    ...(graphitiEnabled ? [graphiti()] : []),
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
    // `TUNNEL_PUBLIC_DOMAIN`); the platform front door passes through. `allow`
    // comes from `TUNNEL_AUTH_ALLOW`, `publicDomain` from `TUNNEL_PUBLIC_DOMAIN`
    // (both set on the deployed app). Codes send through the `email()` transport
    // above. Localhost gets an explicit disabled status because its Host header
    // never matches the tunnel domain.
    authGate(),
    // Web-search runtime for the `web_search` / `web_fetch` tools. The
    // web-search model defaults to Gemini, then GPT (the native web-search
    // tool is provider-specific); set `model` / WEB_SEARCH_MODEL to pin one,
    // or `allowedUrls` to restrict which sites are reachable.
    webSearch(),
    // Teams Adaptive Card runtime for the `create_teams_card` tool. Mounts
    // `POST /api/teams/card` (the Cards page previews through it),
    // `POST /api/teams/post`, and the Bot Framework messaging endpoint
    // `POST /api/teams/messages`. Set TEAMS_WEBHOOK_URL to enable posting to a
    // Teams channel.
    //
    // `allowUnauthenticated` lets the Cards page talk to `/messages` - the same
    // route a real Teams channel would call - with no Azure Bot registration, so
    // the demo renders live cards out of the box. It is honored ONLY when
    // NODE_ENV=development (which this demo runs under locally); a real
    // deployment sets TEAMS_APP_ID / TEAMS_APP_PASSWORD instead and gets the
    // JWT-validated, Connector-delivered path.
    teams({ allowUnauthenticated: true }),
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
    // provisions and seeds its own full-text table during setup.
    search({
      allowWrite: true,
      // Full UC name for the Vector Search path; the Lakebase provider derives
      // a Postgres table name from the last segment (`docs`).
      index: process.env.SEARCH_INDEX,
      // The endpoint is used only by native Vector Search lifecycle operations.
      ...(process.env.SEARCH_ENDPOINT ? { endpoint: process.env.SEARCH_ENDPOINT } : {}),
      indexes: [{ name: process.env.SEARCH_INDEX, alias: SEARCH_ALIAS, columns: SEARCH_COLUMNS }],
      columns: SEARCH_COLUMNS,
      ...(USE_VECTOR_SEARCH ? { ensureOnSetup: { documents: SEARCH_DOCUMENTS } } : {}),
    }),
    mastra({
      storage: mastraStorage,
      memory: mastraMemory,
      // Fail boot unless MLFLOW_EXPERIMENT_ID or MLFLOW_EXPERIMENT_NAME is set.
      // The deployed app binds `/Shared/dbx-tools-demo` and the Apps OTLP sidecar.
      feedback: true,
      agents: { support, "support-polling": supportPolling },
      defaultAgent: "support",
      genieAgentMode: true,
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
      // Fold Databricks' own AI Tools skills into the agents. Read straight
      // from the public databricks/databricks-agent-skills repo, so this works
      // in a deployed App container where the `databricks` CLI is absent.
      ...(remoteSkillsEnabled ? { remoteSkills: "aitools" as const } : {}),
    }),
  ],
  onPluginsReady(appkit) {
    appkit.server.extend((application) => configureStaticDelivery(application, clientDist));
  },
  // Front the app with a public portr tunnel IN-PROCESS: `tunnelInterceptor`
  // applies the computed DATABRICKS_HOST, launches portr pointed at this app's
  // public port, and binds it so the app and portr live/die as one. Local
  // development omits the tunnel so localhost never enters the OTP flow.
  interceptor: !localDevelopment ? tunnelInterceptor() : undefined,
  cache: {
    enabled: true,
  },
});
