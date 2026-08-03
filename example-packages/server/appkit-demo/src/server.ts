import path from "node:path";
import { fileURLToPath } from "node:url";
import { genie, lakebase, server } from "@databricks/appkit";
import { createApp, databricks } from "@dbx-tools/appkit";
import {
  agents,
  genie as mastraGenie,
  plugin as mastraPlugin,
  type MastraAgentDefinition,
  type MastraTools,
} from "@dbx-tools/appkit-mastra";
import {
  plugin as webSearchPlugin,
  tool as webSearchToolModule,
} from "@dbx-tools/appkit-web-search";
import {
  brand as emailBrand,
  plugin as emailPlugin,
  tool as emailToolModule,
} from "@dbx-tools/email";
import { plugin as searchPlugin, tool as searchToolModule } from "@dbx-tools/search";
import { brand as sharedBrand, env as sharedEnv } from "@dbx-tools/shared-core";
import { plugin as teamsPlugin, tool as teamsToolModule } from "@dbx-tools/teams";
import { interceptor as tunnelInterceptorModule, plugin as tunnelPlugin } from "@dbx-tools/tunnel";
import { z } from "zod";

import { logDependencies } from "./dependencies.ts";
import { busDemo } from "./bus-demo.ts";

/** Default search index used by both AppKit resource validation and the plugin. */
const DEFAULT_SEARCH_INDEX = "reggie_pierce_aws_catalog.ai_search.docs";

const { createApp: createAppAuto } = createApp;
const { email } = emailPlugin;
const { defaultEmailBrand } = emailBrand;
const { emailTool } = emailToolModule;
const { createAgent, tool } = agents;
const { GENIE_INSTRUCTIONS } = mastraGenie;
const { mastra } = mastraPlugin;
const { webSearch } = webSearchPlugin;
const { webSearchTool, webFetchTool } = webSearchToolModule;
const { teams } = teamsPlugin;
const { teamsCardTool } = teamsToolModule;
const { search } = searchPlugin;
const { searchTool, universalSearchTool, addDocumentsTool, createIndexTool, syncIndexTool } =
  searchToolModule;
const { defaultBrandContext } = sharedBrand;
const mastraStorage = sharedEnv.boolean(undefined, "MASTRA_STORAGE") ?? true;
const mastraMemory = sharedEnv.boolean(undefined, "MASTRA_MEMORY") ?? true;
const { tunnelInterceptor } = tunnelInterceptorModule;
const { authGate } = tunnelPlugin;

// The browser bundle built by the sibling `@dbx-tools/demo-appkit-app` package.
// `server({ staticPath })` serves it on the same port as the API. Locally the
// bundle lives beside the sibling package; a deployed Databricks App instead
// stages it into the app root and points here with `CLIENT_DIST`, since the
// sibling path does not exist in the deployed tree.
const clientDist =
  process.env.CLIENT_DIST ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../app/appkit-demo/dist");

// AppKit demo wiring for `@dbx-tools/appkit-mastra`.
//
// `createAppAuto` here is the auto-configuring wrapper from
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
// 1. `server()` and `lakebase()` register before `mastra()` so the
//    `setup:complete` lifecycle hook can open the Lakebase pool when
//    Mastra storage/memory are enabled.
// 2. `mastra(...)` mounts a chat route per registered agent under
//    `/api/mastra/route/chat/<agentId>` (plus `/route/chat` bound to
//    the default). Each agent resolves its model from the workspace
//    `/serving-endpoints` with user-scoped auth (`asUser(req)`).
// 3. `lakebase()` backs Mastra Memory (`PostgresStore` + `PgVector`)
//    when `storage` / `memory` are true on the mastra plugin.
//
// Genie integration: register the AppKit `genie()` plugin for its
// resource manifest (so `app.yaml` picks up the Genie space binding)
// and its `spaces` config format. The `mastra()` plugin's
// `plugins.genie?.toolkit()` callback returns a flat set of Genie
// tools (`ask_genie`, `get_statement`, `prepare_chart`,
// `get_space_description`, `get_space_serialized`) the central
// agent drives directly. The tools talk to Genie via
// `@dbx-tools/genie` for streaming + `getStatement`-backed row
// hydration; no inner Genie orchestrator agent.
//
// Assistant skills: `createAgent` defaults `workspace` to
// `createWorkspace()`, which mounts read-only Databricks paths
// `/Workspace/.assistant/skills` and `/Users/<email>/.assistant/skills`.
//
// Required env vars (see .env.example):
// - DATABRICKS_SERVING_ENDPOINT_NAME=databricks-claude-sonnet-4-6
// - LAKEBASE_PROJECT (or LAKEBASE_ENDPOINT) - autopg fills in the rest
// - DATABRICKS_GENIE_SPACE_ID - picked up by `genie()` as the
//   `default` space when `spaces` is omitted.

// Agents are declared the same way as AppKit's `agents` plugin:
// build each definition with `createAgent({...})` (a no-op identity
// helper for inference), then hand it to `mastra({ agents })`.
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
// `model` falls back to `DATABRICKS_SERVING_ENDPOINT_NAME` then to a
// built-in default. Whatever id wins is fuzzy-matched against the
// workspace's live `/serving-endpoints` list (cached for 5 min), so
// loose values like `"claude sonnet"` snap to the real endpoint name.
// Per-request overrides via `X-Mastra-Model` header, `?model=` query,
// or body `model` field can re-target the same agent without redeploy.
// `GET /api/mastra/models` lists the cached catalogue.
const supportDefinition: MastraAgentDefinition = {
  name: "support",
  instructions: [
    "You are a data analyst helping customers explore a Databricks",
    "Genie space. Default to driving the Genie tools (`ask_genie`,",
    "`get_statement`, `prepare_chart`, `get_space_description`,",
    "`get_space_serialized`) below - they are the only way to see",
    "the real data, so use them whenever the user's question is",
    "about the data the space covers. Reserve direct (no-tool)",
    "answers for pure meta-questions about your own behaviour or",
    "the conversation itself.",
    "",
    GENIE_INSTRUCTIONS,
  ].join("\n"),
  tools(plugins): MastraTools {
    // Materialize the dynamic toolkit before adding the demo tools. Building
    // one contextually-typed object makes TypeScript recursively expand every
    // source-linked Mastra tool schema together and exceeds its instantiation
    // depth; Object.assign preserves the same flat runtime record without
    // forcing that useless cross-tool type expansion.
    const agentTools = Object.assign({}, plugins.genie?.toolkit()) as MastraTools;
    Object.assign(agentTools, {
      // Auto-discovered AppKit `ToolProvider` plugins. `plugins.<name>`
      // is `undefined` when the plugin isn't registered, so the `?.`
      // guard keeps this safe to copy into other apps. Include the
      // built-in Genie toolkit so the agent can ask the Genie space
      // (`DATABRICKS_GENIE_SPACE_ID`) for SQL-backed answers.
      // Spread other toolkits once registered (uncomment alongside
      // adding `analytics()` / `files()` to the plugin list below):
      // ...plugins.analytics.toolkit(),
      // ...plugins.files.toolkit({ only: ["uploads.read"] }),
      get_weather: tool({
        description: "Weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
      // Approval-gated email tool from `@dbx-tools/email`. The
      // model can call this freely; execution pauses until the user
      // clicks Approve in the chat UI, then the message is sent for
      // real over SMTP. The sender is derived from the on-behalf-of
      // user's email on the configured `EMAIL_DOMAIN` (system mail, like
      // the tunnel's sign-in code, uses `no-reply@` there instead); SMTP host /
      // credentials come from the `email()` plugin config / env.
      send_email: emailTool(),
      // Web search + fetch from `@dbx-tools/appkit-web-search`.
      // `web_search` runs the Databricks Model Serving native web-search
      // tool, resolving its OWN web-search-capable model (Gemini/GPT) via
      // the `webSearch()` plugin config - independent of this agent's chat
      // model, which may not support web search. `web_fetch` reads a page
      // via got-scraping. Both honor the plugin's optional URL allow-list.
      web_search: webSearchTool(),
      web_fetch: webFetchTool(),
      // Build a Microsoft Teams Adaptive Card from a short structured
      // description. Pure transform (no side effects), so it is not
      // approval-gated; the returned card is previewed on the Cards page and
      // can be posted to a Teams webhook via the `teams()` plugin.
      create_teams_card: teamsCardTool(),
      // Databricks AI Search (Vector Search) from `@dbx-tools/search`.
      // `search` looks up the most relevant rows in the app's configured
      // index (hybrid semantic + keyword) under the caller's identity;
      // `universal_search` fans a query across every configured index and
      // merges the hits. Autocomplete is just a small-`limit` `search`.
      search: searchTool(),
      universal_search: universalSearchTool(),
      // Write surface (enabled below via `search({ allowWrite: true })`):
      // `add_documents` upserts rows into a direct-access index,
      // `create_index` provisions a new Vector Search index (inferring the
      // endpoint, embedding model, key, and text column), and `sync_index`
      // refreshes a Delta Sync index from its source table. These are gated
      // because they change infrastructure/data, so only enable them for a
      // trusted demo.
      add_documents: addDocumentsTool(),
      create_index: createIndexTool(),
      sync_index: syncIndexTool(),
    });
    return agentTools;
  },
};
const support = createAgent(supportDefinition);

// Bind to loopback (`127.0.0.1`) locally so the dev server isn't
// exposed on the LAN, but fall back to `0.0.0.0` when the Databricks
// Apps platform is running us (it reaches the container over the
// LAN-bound interface, so anything else won't accept traffic).
// Override with `HOST=...` if you need a different bind address.
const host = process.env.HOST ?? (databricks.isAppEnv() ? "0.0.0.0" : "127.0.0.1");

// Report what actually resolved before serving anything: the demo can run its
// `@dbx-tools/*` packages from source or from the registry, and only the
// versions on disk say which one this process got.
logDependencies();

// The search plugin's explicit `index` promotes its optional AppKit resource to
// required. Keep resource validation and runtime config on the same resolved
// value instead of spelling the fallback only inside the plugin options.
process.env.SEARCH_INDEX ??= DEFAULT_SEARCH_INDEX;

await createAppAuto({
  plugins: [
    server({ host, staticPath: clientDist }),
    genie(),
    lakebase(),
    // Postgres LISTEN/NOTIFY demo. Every app instance listens on one dedicated
    // Lakebase connection and fans topic broadcasts out to its browser viewers.
    busDemo(),
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
    // above. Inert locally when no tunnel domain is set.
    authGate({}),
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
    // Search runtime for the `search` / `universal_search` tools and the browser
    // search box. `ensureOnSetup` seeds the dummy docs below on boot (background,
    // idempotent) using the app's SDK auth (DATABRICKS_CONFIG_PROFILE in `.env`).
    //
    // The backend is chosen automatically:
    //   - Set SEARCH_ENDPOINT (+ SEARCH_INDEX) and it wires up a REAL Databricks
    //     Vector Search index: a MANAGED direct-access index (Databricks embeds
    //     the `text` column on write AND query - no Delta table, no warehouse).
    //     First boot is slow (endpoint creation takes minutes), runs in the
    //     background, and later boots are no-ops.
    //   - Leave SEARCH_ENDPOINT unset (the default here) and, because `lakebase()`
    //     is registered above, search falls back to a Lakebase (Postgres)
    //     full-text index - same tools, routes, hits, and UI. This zero-Vector-
    //     Search path is what the demo uses out of the box.
    // Mounts `POST /api/search`, `/universal`, `GET /indexes`, and (with
    // `allowWrite`) `/documents`, `/index`, `/index/sync`; the UI reads the
    // catalogue via `usePluginClientConfig("search")`.
    search({
      allowWrite: true,
      // Full UC name for the Vector Search path; the Lakebase fallback derives a
      // Postgres table name from the last segment (`docs`).
      index: process.env.SEARCH_INDEX,
      // Only set the endpoint (-> Vector Search) when one is configured; unset
      // means the Lakebase full-text fallback answers (see the comment above).
      ...(process.env.SEARCH_ENDPOINT ? { endpoint: process.env.SEARCH_ENDPOINT } : {}),
      columns: ["title", "text", "url"],
      ensureOnSetup: {
        embeddingModel: "databricks-gte-large-en",
        documents: [
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
        ],
      },
    }),
    mastra({
      storage: mastraStorage,
      memory: mastraMemory,
      agents: support,
      // Chat runs on-behalf-of the signed-in user by default, so the caller must
      // be a workspace member. Set MASTRA_GENIE_IDENTITY=service-principal (or
      // genieIdentity: "service-principal" here) to run the agents' Databricks
      // calls as the app service principal instead, so any account user who can
      // open the app can chat even without workspace membership. The DEPLOYED
      // demo sets `auto` (see databricks.yml): it is served through the OTP
      // tunnel, where a caller proves an email but forwards no Databricks
      // token, so per-request fallback is the only setting that serves the
      // tunnel and the workspace front door correctly at once.
      // Themes charts from the `render_data` / `prepare_chart` tools with the
      // same brand the client UI (`BrandProvider`) and email layouts use, so a
      // generated chart matches the surrounding AppKit UI instead of falling
      // back to Echarts' defaults.
      brand: defaultBrandContext,
      // Fold Databricks' own AI Tools skills into the agents. Read straight
      // from the public databricks/databricks-agent-skills repo, so this works
      // in a deployed App container where the `databricks` CLI is absent.
      remoteSkills: "aitools",
    }),
  ],
  // Front the app with a public portr tunnel IN-PROCESS: `tunnelInterceptor`
  // applies the computed DATABRICKS_HOST, launches portr pointed at this app's
  // public port, and binds it so the app and portr live/die as one. A no-op when
  // no PORTR_TOKEN / TUNNEL_PUBLIC_DOMAIN is set (local runs, or a deploy without a
  // tunnel), so it is safe to register unconditionally.
  interceptor: tunnelInterceptor(),
  cache: {
    enabled: true,
  },
});
