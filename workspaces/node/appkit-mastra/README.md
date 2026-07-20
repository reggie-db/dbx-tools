# @dbx-tools/appkit-mastra

AppKit plugin and server-side toolkit for hosting Mastra agents inside a
Databricks App.

Import this package when an AppKit backend needs an agent service with
Databricks on-behalf-of auth, optional Lakebase-backed memory, Databricks Genie
tools, model selection, chart/data embeds, MLflow feedback, and MCP exposure.
The package mounts the standard Mastra agent stream under the AppKit server, so
clients can use Mastra-compatible chat transports instead of a custom protocol.

Key features:

- AppKit plugin lifecycle integration: routes, setup, shutdown, sibling plugin
  access, and AppKit request context are handled inside `plugin.mastra()`.
- Agent composition: define one or more Mastra agents, give each one local tools,
  AppKit plugin toolkits, workspace skills, model defaults, and approval-gated
  tools.
- Databricks execution model: tool calls run with the active AppKit OBO client
  where available, while storage and background work use service-principal
  connections.
- Durable conversations: Lakebase-backed Mastra storage provides thread
  history, message persistence, and optional vector memory.
- Rich data answers: Genie tools, statement fetches, chart preparation, and
  embed markers let an agent answer with text plus delayed chart/table payloads.
- Operational surfaces: model-list routes, feedback routes, MCP exposure,
  scoped API gating, tracing, and MLflow feedback are bundled with the plugin.

## Why Not Just AppKit Agents?

Native AppKit includes a beta Agents plugin with markdown and TypeScript agent
definitions, AppKit tool-provider integration, streaming chat, thread
management, cancellation, and HITL approval. Use it when you want the AppKit
agent model and do not need a separate agent framework.

Use this package when you specifically want Mastra inside AppKit:

- Mastra's larger plugin/tool ecosystem, MCP support, memory/storage model,
  workflow primitives, and `@mastra/client-js` stream shape.
- AppKit toolkits as Mastra tools, so Analytics, Files, Genie, and other AppKit
  ToolProvider plugins stay available without rewriting them.
- Genie as an agent tool that emits typed progress events, result metadata, and
  delayed chart/data markers into the same assistant turn.
- A paired React client in [`@dbx-tools/ui-mastra`](../../ui/mastra) with model
  picking, thread sidebar, approvals, feedback, exports, and inline embeds.
- Per-request model override and fuzzy endpoint resolution through
  [`@dbx-tools/model`](../model), instead of binding every agent to a fixed
  endpoint name.

## Quick Start

```ts
import { analytics, createApp, lakebase, server } from "@databricks/appkit";
import { agents, genie, plugin } from "@dbx-tools/appkit-mastra";
import { z } from "zod";

const analyst = agents.createAgent({
  name: "analyst",
  instructions: ["You answer questions about workspace data.", genie.GENIE_INSTRUCTIONS].join(
    "\n\n",
  ),
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(),
      ...plugins.genie?.toolkit(),
      get_weather: agents.tool({
        description: "Get a simple weather report.",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
    };
  },
});

await createApp({
  plugins: [
    server(),
    analytics(),
    lakebase(),
    plugin.mastra({
      agents: { analyst },
      defaultAgent: "analyst",
      genie: { spaces: { sales: "01ef..." } },
    }),
  ],
});
```

Benefits of importing the package:

- `plugin.mastra()` registers a full AppKit plugin named `mastra`.
- `agents.createAgent()` keeps agent definitions typed and applies the default
  Databricks workspace/skill mounts.
- `agents.tool()` lets the same AppKit-shaped tool body work in this Mastra
  plugin.
- `genie.GENIE_INSTRUCTIONS` and `plugins.genie.toolkit()` give agents a
  Databricks Genie workflow without embedding a second agent.
- Lakebase registration automatically enables durable thread storage and vector
  memory unless you opt out.

## Agent Registration

`plugin.mastra({ agents })` accepts a single definition, an array, or a record.
Records are best when clients need stable agent ids:

```ts
plugin.mastra({
  agents: {
    support: agents.createAgent({ instructions: "Answer support questions." }),
    analyst: agents.createAgent({ instructions: "Analyze workspace data." }),
  },
  defaultAgent: "support",
});
```

When no agents are supplied, the plugin registers a built-in `default` analyst so
the route surface still works for smoke tests. Each agent is streamed through the
Mastra agent API mounted below the plugin path, typically `/api/mastra`.

Use `agents.createTool` when you need Mastra-native fields such as
`outputSchema`, `suspendSchema`, `requireApproval`, or MCP metadata. Use
`agents.tool` for the smaller AppKit-compatible shape:

```ts
const approveRefund = agents.createTool({
  id: "approve_refund",
  description: "Approve a refund request.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  requireApproval: true,
  execute: async ({ context }) => approve(context.orderId, context.amount),
});
```

## AppKit Toolkits

The `tools(plugins)` callback receives a dynamic index of registered AppKit
tool-provider plugins. Each entry exposes `.toolkit(opts)` with AppKit-compatible
`prefix`, `only`, `except`, and `rename` options.

```ts
const agent = agents.createAgent({
  instructions: "Use the narrowest tool that answers the question.",
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit({ only: ["query"] }),
      ...plugins.files?.toolkit({ prefix: "files.", except: ["delete"] }),
    };
  },
});
```

Tool calls dispatch back through the owning AppKit plugin, preserving OBO auth
and AppKit telemetry behavior. Optional plugins should be guarded with `?.` when
you spread their tools.

## Memory And Storage

The `memory` and `storage` config fields can be `false`, `true`, or a concrete
Mastra Postgres/PgVector config.

```ts
plugin.mastra({
  agents: analyst,
  storage: true,
  memory: { id: "analytics_memory", tableName: "agent_memory" },
});
```

With `lakebase()` registered, both default to enabled:

- storage uses a per-agent schema for durable threads and messages;
- memory uses a shared vector index for semantic recall;
- the service-principal pool is created outside any request so OBO user
  identities are not captured in background storage work.

Without `lakebase()`, agents are stateless unless you provide explicit storage
and memory configs.

## Workspace Skills

Every `agents.createAgent()` gets a default Mastra `Workspace` from
`workspaces.createWorkspace()`. It mounts Databricks Workspace files through the
current OBO user's `WorkspaceClient`, so Mastra can discover Assistant-style
`SKILL.md` files at request time.

```ts
const agent = agents.createAgent({
  instructions: "Use mounted workspace skills when relevant.",
  workspace: workspaces.createWorkspace({
    assistantSkills: true,
    mounts: [
      async () => ({
        mounts: { "/reference": myFilesystem },
        skillPaths: ["/reference/skills"],
      }),
    ],
  }),
});
```

Production workspace mounts require a forwarded token with `workspace`,
`workspace.workspace`, or `all-apis` scope. Development mode skips that gate for
local iteration.

## Genie Tools

`genie.buildGenieTools()` and `plugins.genie.toolkit()` expose tools for:

- asking a configured Genie space;
- reading space descriptions and serialized space metadata;
- fetching statement rows by `statement_id`;
- preparing charts from Genie result sets.

The central agent drives those tools directly. Genie events stream through the
Mastra writer using the shared contract from
[`@dbx-tools/shared-mastra`](../../shared/mastra), so clients can show thinking,
SQL, row counts, summaries, chart markers, and data markers as the turn runs.

```ts
const agent = agents.createAgent({
  instructions: `${baseInstructions}\n\n${genie.GENIE_INSTRUCTIONS}`,
  tools(plugins) {
    return { ...plugins.genie?.toolkit({ prefix: "" }) };
  },
});
```

## Charts And Data Embeds

`chart.prepareChart()` mints a chart id immediately, caches an in-progress
record, resolves the data in the background, and stores a terminal chart or
error. `chart.fetchChart()` long-polls that cache for route handlers and custom
clients.

```ts
const { chartId } = await chart.prepareChart({
  config,
  request: {
    title: "Revenue by region",
    chartType: "bar",
    instructions: "Compare total revenue by region.",
    data: rows,
  },
  resolveData: async () => rows,
});

const resolved = await chart.fetchChart(chartId);
```

Agents can return `[chart:<id>]` and `[data:<statement_id>]` markers in prose.
The embed route resolves them later, which avoids forcing the language model to
inline large tables or wait for chart planning before continuing its answer.

### Brand The Charts

Pass a `brand` to the plugin to theme every generated chart with your brand's
palette and font; omit it for the default Echarts look.

```ts
import { brand } from "@dbx-tools/shared-core";

plugin.mastra({ agents, storage: true, brand: brand.defaultBrandContext });
```

`brand` is the portable `BrandContext` shared across the UI, email, and
libraries, so charts, email, and the chat UI theme from one source. The chart
planner derives an Echarts theme from it: a series color cycle seeded from
`colors.primary` / `colors.accent` (plus a colorblind-friendly spread so
many-series charts stay legible) and a base text style from `typography.sans` /
`colors.foreground`. Charts render to canvas, so this is applied server-side on
the Echarts option rather than through the browser `[data-brand]` CSS bridge.

## Model Selection

`model.buildModel()` adapts the generic resolver from
[`@dbx-tools/model`](../model) to Mastra. It resolves the model per request,
so OBO identity and request-specific overrides stay isolated.

Model priority is:

1. request override (`X-Mastra-Model`, `?model=`, body `model` / `modelId`);
2. per-agent `model`;
3. plugin `defaultModel`;
4. `DATABRICKS_SERVING_ENDPOINT_NAME`;
5. workspace catalogue ranking and static fallback floor.

```ts
plugin.mastra({
  agents: analyst,
  defaultModel: "claude sonnet",
  modelFuzzyMatch: true,
  modelOverride: true,
});
```

Use `serving.extractModelOverride()` and `serving.resolveServingConfig()` when
building custom routes that should behave like the plugin's `/models` and stream
routes.

The plugin also serves `GET /default-model` (and `/default-model/:agentId`),
returning `{ agentId, model, displayName }` - the static serving-endpoint an
agent falls back to when the client pins no model, plus its humanized label.
`model` / `displayName` are `null` when the agent resolves its model
dynamically at call time. This lets a model picker label its default option
without waiting on the `/models` catalogue (so it never flashes a raw id).

## Threads, History, And Suggestions

When storage is enabled, the plugin provides route helpers and in-process
functions for conversation management:

- `history.loadHistory()` and `history.clearHistory()` read or clear one thread;
- `threads.listThreads()`, `threads.renameThread()`, and
  `threads.deleteThread()` operate on the caller's scoped conversations;
- `genie.collectSpaceSuggestions()` reads starter questions from the configured
  Genie space.

The plugin resolves the active thread from `x-mastra-thread-id`, `?threadId=`,
or a per-session fallback cookie. That keeps streaming, history, and clear
operations aligned around the same conversation id.

## Feedback And Observability

`observability.buildObservability()` wires Mastra tracing when OTLP export is
configured. `mlflow.resolveFeedbackEnabled()` turns MLflow feedback on when both
trace export and an MLflow experiment are configured, unless the plugin config
forces a value.

```ts
plugin.mastra({
  agents: analyst,
  feedback: true,
});
```

`mlflow.logFeedback()` logs a human assessment against the active MLflow trace.
The response header name and request/response schemas live in
[`@dbx-tools/shared-mastra`](../../shared/mastra).

## MCP Exposure

`mcp.buildMcpServer()` exposes registered agents as MCP tools by default. The
AppKit plugin publishes clean aliases under its base path:

```ts
plugin.mastra({
  agents: analyst,
  mcp: {
    serverId: "analytics",
    name: "Analytics MCP",
    tools: false,
  },
});
```

Use `mcp: false` to disable MCP. Turn on `tools: true` only for ambient tools
that are safe outside an in-process chat turn.

## API Gate

The stock `@mastra/express` app has broad management routes. The plugin's
default `apiAccess: "scoped"` allows only the chat, read-only metadata,
plugin-owned `/route/*`, embed, model, suggestion, and MCP surfaces that the
client needs. Use `apiAccess: "full"` only for a trusted first-party console.

`server.isMastraRequestAllowed()` is exported for tests and custom dispatch
logic that need the same allowlist.

## Configuration Reference

The plugin config is intentionally centered on the AppKit lifecycle instead of
requiring callers to assemble a Mastra server by hand.

- `agents` registers a single agent, an array, or a record keyed by stable agent
  ids. Records are best for UIs because the ids become route-visible.
- `defaultAgent` controls which registered agent handles requests that do not
  name an agent explicitly.
- `storage` and `memory` accept `true`, `false`, or concrete Mastra Postgres /
  PgVector options. `true` resolves from `lakebase()` when present.
- `genie.spaces` maps aliases to Genie Space IDs. Those aliases flow into tools,
  suggestions, and chart/data workflows.
- `defaultModel`, `modelOverride`, and `modelFuzzyMatch` control how loose model
  names are resolved through Databricks Model Serving.
- `feedback` controls whether MLflow feedback routes are exposed. The automatic
  mode enables feedback when tracing and an MLflow experiment are configured.
- `mcp` controls whether agents are exposed as MCP tools and how that server is
  named.
- `apiAccess` chooses the route allowlist. Keep the default scoped mode for
  deployed apps.

Use this package when you want an AppKit-native agent runtime. Use the shared
schemas in [`@dbx-tools/shared-mastra`](../../shared/mastra) when building a
client that talks to these routes.

## Modules

- `plugin` - `MastraPlugin` and `mastra()` AppKit plugin factory.
- `agents` - `createAgent`, `tool`, `createTool`, agent build helpers, fallback
  defaults, and approval-gated tool inspection.
- `config` - plugin config types and RequestContext key constants.
- `model` / `serving` / `servingSanitize` - Mastra model config, request
  overrides, serving-endpoint config, and request-body cleanup.
- `genie` - Genie prompt, space normalization, Genie toolkits, and suggestions.
- `chart` / `statement` / `writer` - chart cache, statement row fetches, and
  safe writer events.
- `history` / `threads` / `pagination` - conversation persistence helpers and
  route handlers.
- `memory` / `storageSchema` - Lakebase-backed Mastra store/vector setup.
- `workspaces` / `filesystems` - Mastra workspace creation and Databricks
  Workspace file adapters.
- `mcp` - MCP server construction.
- `observability` / `mlflow` - tracing and feedback.
- `server` / `rest` / `processors` - Express dispatch, Databricks REST helpers,
  stream/result processors.

Browser-facing wire types are in
[`@dbx-tools/shared-mastra`](../../shared/mastra). Genie event contracts are in
[`@dbx-tools/shared-genie`](../../shared/genie). Model request/result contracts
are in [`@dbx-tools/shared-model`](../../shared/model). The matching React chat
surface is [`@dbx-tools/ui-mastra`](../../ui/mastra).
