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
  connections. Set `genieIdentity: "service-principal"` to run the agents'
  Databricks calls as the app service principal instead, so callers who can open
  the app but are not workspace members can still chat, or `"auto"` to make that
  fallback per-request - OBO when the caller forwards a token, service principal
  when they cannot.
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
      genieSpaces: { sales: "01ef..." },
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

### Tools Flow In, Not Out

The plugin is a tool _consumer_, not an AppKit `ToolProvider`: it deliberately
implements neither `getAgentTools()` nor `executeAgentTool()`, so its built-in
tools (`ask_genie`, `get_space_description`, `get_space_serialized`,
`get_statement`, `prepare_chart`, `render_data`, `summarize`) are reachable only
from a Mastra agent turn this plugin serves.

That is a property of the tools, not a gap. Each one reads the per-request
Mastra execution context - the AppKit user stamped on `RequestContext`, the
`writer` that streams Genie progress events to the chat, the per-call
`abortSignal` - and refuses to run without it. An AppKit `ToolProvider` call
carries none of that, so exposing these through one would advertise tools that
cannot work. Reach for
[native AppKit Agents](https://developers.databricks.com/docs/appkit/v0) when you
want your agent tools callable by other AppKit hosts.

Nothing here can be auto-inherited by another host as a side effect: with no
AppKit `ToolRegistry`, there is no `autoInheritable` surface to opt in or out
of. Every built-in tool is also read-only (Genie questions, statement reads,
chart planning, summarization), and the ambient tools stay off the MCP server
unless `mcp: { tools: true }` names them explicitly. Approval-gated tools you
register yourself are enforced separately: boot fails if one is registered
without Mastra storage to persist the suspended run.

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

Locations are a named map (`skillFolders`), so an app refers to a tree by name
rather than repeating a path. Each name mounts at `/<name>` in the workspace
namespace (override with `mount`) and carries its own policy: `readable`
(scanned for `SKILL.md`, default `true`) and `writable` (default `false`).
`DEFAULT_SKILL_FOLDERS` supplies these:

| Name                 | Location                           | Readable | Writable |
| -------------------- | ---------------------------------- | -------- | -------- |
| `workspace-team`     | `/Workspace/.assistant/skills`     | yes      | no       |
| `workspace-team-app` | `/Users/<email>/.assistant/skills` | yes      | yes      |

A consuming library merges over that map: a matching name overrides the
default, `false` disables it, and any other name adds a location. A folder
points at a Databricks `path` (a literal, or a function resolving one per
request) or supplies a ready `filesystem` for anything the OBO client cannot
reach.

```ts
const agent = agents.createAgent({
  instructions: "Use mounted workspace skills when relevant.",
  workspace: workspaces.createWorkspace({
    skillFolders: {
      // Point an existing name somewhere else.
      "workspace-team": { path: "/Workspace/Shared/team-skills" },
      // Drop a default entirely.
      "workspace-team-app": false,
      // Add an app-owned tree the agent may write back to.
      runbooks: { path: "/Workspace/Shared/runbooks/skills", writable: true },
      // Mount for file tools without adding it to skill discovery.
      templates: { path: "/Workspace/Shared/templates", readable: false },
      // Any Mastra filesystem works, including per-request ones.
      volume: { filesystem: ({ requestContext }) => volumeFor(requestContext) },
    },
    mounts: [
      async () => ({
        mounts: { "/reference": myFilesystem },
        skillPaths: ["/reference/skills"],
      }),
    ],
  }),
});
```

A folder whose location resolves to `undefined` is skipped for that request,
which is how `workspace-team-app` drops out when no user email is stamped.
`assistantSkills: false` starts from an empty map, leaving only the
`skillFolders` given. Production workspace mounts require a forwarded token
with `workspace`, `workspace.workspace`, or `all-apis` scope. Development mode
skips that gate for local iteration.

## Remote Skills

Workspace skills above are discovered from files ALREADY in the Databricks
workspace. `remoteSkills` provisions skills from OUTSIDE it at startup - a
GitHub `owner/repo`, a git / GitLab URL, or a direct `SKILL.md` / archive
download URL - so an app can ship with a curated skill set without anyone
hand-uploading `SKILL.md` trees first.

```ts
mastra({
  agents: { assistant: agents.createAgent({ instructions: "..." }) },
  remoteSkills: [
    "owner/skill-repo",
    { source: "https://example.com/skills/writing.md", failOnError: false },
  ],
});
```

Each source is materialized at boot into an Assistant-style `SKILL.md` tree that
the default workspace then scans, so a provisioned skill behaves exactly like
one that was in the workspace all along. Resolution per source:

- if the optional `skills` peer dependency is installed, the source is copied
  into a staging dir with the `skills` CLI, which understands every source
  format the ecosystem does (GitHub shorthand, git URLs, archive URLs);
- otherwise the source URL is fetched directly and its `SKILL.md` written to the
  staging dir. A non-URL source (e.g. bare `owner/repo`) without the `skills`
  package installed cannot be resolved this way and fails.

The default destination is the Databricks workspace Assistant skills tree
(`/Workspace/.assistant/skills`, the same tree a "save this as a skill" action
writes to), so provisioned skills persist across restarts and are picked up by
the built-in Assistant-skills mount. Pass `userEmail` to target that user's
`/Users/<email>/.assistant/skills` instead, or `databricksBasePath` for an
explicit tree. When no Databricks client is resolvable at startup, the tree is
written to a local temp dir and handed to Mastra as an extra local skill path
for the current process only.

A source that resolves through neither path fails app startup, so a misconfigured
skill set is caught at boot rather than silently missing. Set `failOnError: false`
(top-level or per-source) to log and skip a bad source instead. Install the
optional peer to enable the richest source formats:

```sh
pnpm add skills
```

### Refresh policy

Provisioning runs on every app boot, and skill trees change rarely, so each
provisioned tree carries a `.metadata.json` at its root recording when each
source was last downloaded. A source is only re-downloaded once that record is
older than a day; inside the window the existing tree is reused and no network
call is made. The record travels with the tree rather than living in process
memory, so a container that restarts a dozen times an hour pulls each source
once, not a dozen times.

```ts
mastra({
  // Re-pull at most once an hour instead of once a day.
  remoteSkills: { sources: ["aitools"], refreshTtlMs: 60 * 60 * 1000 },
});

// Per-source, and `0` to download on every boot:
mastra({
  remoteSkills: {
    sources: [{ source: "owner/skill-repo", refreshTtlMs: 0 }, "aitools"],
  },
});
```

The record is keyed by the source AND the options that change what it contains
(`skills`, `experimental`, `ref`), so narrowing a skill list or moving a `ref`
re-downloads immediately rather than serving the previous selection for a day.
A missing or unreadable record is treated as a cache miss, never as a startup
failure.

## Databricks AI Tools

[Databricks AI Tools](https://github.com/databricks/databricks-agent-skills) are
Databricks-owned Agent-Skill trees (bundles, jobs, SQL, Genie, and more). The
`"aitools"` source folds them into every default-workspace agent, so an agent
gets first-class Databricks skills without anyone hand-copying `SKILL.md` files:

```ts
mastra({
  agents: { assistant: agents.createAgent({ instructions: "..." }) },
  remoteSkills: "aitools",
});

// A curated subset, plus another source alongside it:
mastra({
  remoteSkills: [
    { source: "aitools", skills: ["databricks-core", "databricks-jobs"] },
    "owner/repo",
  ],
});
```

**No CLI required.** `databricks aitools install` resolves its skills from the
PUBLIC `databricks/databricks-agent-skills` repo, so this reads the same repo
directly: it fetches the repo's generated `manifest.json` (which names each
skill's files and whether it lives under `skills/` or `experimental/`) and
downloads them. That matters because a deployed Databricks App container has no
`databricks` CLI - the old CLI shell-out simply never produced skills there.
No Databricks auth is involved either, since the repo is public.

Per-source options for `"aitools"`:

- `skills` - install only the named skills instead of the full stable set.
- `experimental` - include the repo's `experimental/` skills (off by default).
- `ref` - pin a tag / branch / sha. Defaults to `main`.

Because these skills track a public repo rather than the workspace, they are
added as LOCAL scan paths for the current process rather than uploaded to the
Databricks Assistant tree.

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
Independent `ask_genie` calls can run in parallel. One invocation owns the
thread's reusable Genie conversation while overlapping invocations use isolated
conversations, preventing concurrent messages from colliding in one Genie
conversation. Sequential calls continue to reuse conversation context.

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

Both take a `userKey`: the chart cache is namespaced by the caller's identity,
so a chart id lifted from another user's transcript resolves to nothing and the
embed route answers `404`. Use `config.resolveUserKey()`, which reads the AppKit
user off the Mastra request context and falls back to the ambient execution
context. Outside a Mastra turn, where there is a request but no request context,
use `config.attributedUserId(getExecutionContext(), requestUserId(req))` instead.
Both spell the same rule, which matters under `genieIdentity:
"service-principal"`: the shared credential is the app service principal, but
charts stay keyed to the forwarded caller, so a reader that keyed off the
credential alone would miss every chart and show it as expired.

```ts
const userKey = config.resolveUserKey(requestContext);

const { chartId } = await chart.prepareChart({
  config: pluginConfig,
  userKey,
  title: "Revenue by region",
  description: "Compare total revenue by region.",
  resolveData: async () => ({ rows }),
});

const resolved = await chart.fetchChart(chartId, { userKey });
```

Agents can return `[chart:<id>]` and `[data:<statement_id>]` markers in prose.
The embed route resolves them later, which avoids forcing the language model to
inline large tables or wait for chart planning before continuing its answer.

### Chart Types And Hand-Written Charts

The planner does not emit a raw Echarts option. It fills a small plan (chart
type, categories, series) that `planToEchartsOption` expands, so tooltip,
legend, grid, and brand defaults stay consistent and a fast model has few ways
to go wrong. The vocabulary is `bar`, `horizontalBar`, `line`, `area`, `combo`,
`waterfall`, `scatter`, `heatmap`, `radar`, `pie`, `funnel`, `treemap`.

Some of those are Echarts series types and some are not. `heatmap`, `radar`,
`pie`, `funnel`, `treemap`, and `scatter` map to native series. `area` compiles
to a line with an `areaStyle`, `horizontalBar` to a bar with swapped axes,
`combo` to per-series types, and `waterfall` to the stacked transparent-helper
bars Echarts documents, since it has no waterfall series.

For a chart the plan cannot express at all - sankey, boxplot, candlestick,
sunburst, gauge, network graph, calendar, parallel coordinates, a `custom`
series - the planner picks `custom` and hand-writes the entire Echarts option
into the plan's `option` field. That option is passed through as-is: no axes,
tooltip, or legend are grafted on, and only a centered title is filled in when
the object omits one. A configured `brand` theme still applies underneath, so
anything the option sets wins over it.

`option` is a JSON object encoded in a **string**, not a nested object, and
that is deliberate. The plan is the planner's provider-enforced structured
output, so a free-form object would become an unconstrained
`additionalProperties` schema, which strict OpenAI and Gemini serving endpoints
reject outright. That would break every chart rather than one. A string is
universally representable, and a malformed one fails only its own chart. Values
must be plain JSON: a string-valued Echarts formatter is treated as a template,
and nothing in the option is ever evaluated as code.

Prefer a listed type whenever one fits. `custom` trades the shared defaults for
reach, so it is the answer for an unsupported chart shape, not a way to restyle
a supported one.

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
many-series charts stay legible) and the `typography.sans` font stack. Charts
render to canvas, so this is applied server-side on the Echarts option rather
than through the browser `[data-brand]` CSS bridge.

What the planner does **not** set is any text color. A spec is planned here and
read later in a browser whose light/dark theme the server cannot know, so the
brand's single (light) foreground would produce near-black labels on a dark chat
surface. The renderer resolves tick labels, axis names, grid lines, and the
tooltip from AppKit's live CSS tokens instead - see
[`@dbx-tools/ui-mastra`](../../ui/mastra)'s chart theming. Brand identity is the
same in either mode; chrome is not.

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
without waiting on the `/models` catalogue (so it never flashes a raw id). A
`:agentId` that is not registered returns `404` with the registered ids, the
same as the history and threads routes.

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
forces a value. The plugin also stamps each chat turn's request/response onto
the HTTP root span via `traceIo.attachChatTurnTraceIo()` so MLflow's UC
`*_trace_unified` view can show them (Mastra's own `mastra.agent_run.*`
attributes sit on a child span that view never reads).

```ts
plugin.mastra({
  agents: analyst,
  feedback: true,
});
```

`mlflow.logFeedback()` logs a human assessment against the active MLflow trace.
The response header name and request/response schemas live in
[`@dbx-tools/shared-mastra`](../../shared/mastra).

### Databricks Apps -> Unity Catalog (the supported path)

Managed MLflow has **no** OTLP ingest endpoint. Do not set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the workspace host - probes of
`/api/2.0/mlflow/v1/traces`, `/otlp/v1/traces`, and similar paths 404. The
mechanism that works is Databricks Apps telemetry: declare
`telemetry_export_destinations` on the app resource so the platform injects a
local OTLP sidecar (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4314`,
`OTEL_EXPORTER_OTLP_PROTOCOL=grpc`) and persists spans to Unity Catalog. Point
the three tables at the MLflow experiment's existing UC trace location (do not
invent a parallel table set):

```yaml
variables:
  telemetry_schema:
    default: my_catalog.my-traces-schema
  mlflow_experiment_id:
    default: "123456789"

resources:
  apps:
    my_app:
      # ...
      config:
        env:
          - name: MLFLOW_EXPERIMENT_ID
            value: ${var.mlflow_experiment_id}
          # Apps ingress stamps traceparent on every request. Without this,
          # every HTTP span is a child of a platform span that never lands in
          # the UC tables, so `*_trace_unified` (root = empty parent_span_id)
          # discards every chat turn.
          - name: OTEL_PROPAGATORS
            value: none
      telemetry_export_destinations:
        - unity_catalog:
            traces_table: ${var.telemetry_schema}.${bundle.target}_otel_spans
            logs_table: ${var.telemetry_schema}.${bundle.target}_otel_logs
            metrics_table: ${var.telemetry_schema}.${bundle.target}_otel_metrics
```

All three table fields are required. The app service principal needs
`USE_CATALOG` / `USE_SCHEMA` / `SELECT` / `MODIFY` on that catalog.schema (the
Apps API also tries to grant access and fails with 403 if you lack `MANAGE` on
the catalog). Reject `mlflow-tracing` TypeScript SDK for this path: it claims
the global provider AppKit already owns and writes to a different store.

Success in the boot log looks like:

```
[observability] Mastra observability wired through OTel bridge {
  otelBase: 'http://localhost:4314', feedback: true, observability: 'mlflow'
}
```

Verify with SQL against the UC `*_trace_unified` view (the REST
`traces/search` API only covers the experiment store, not UC-backed traces).
Schema names with hyphens need backticks; `attributes` is a `VARIANT`, so use
`attributes:['key']::string` rather than `map_keys()`.

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

## Driving A Turn From Outside The Routes

Another plugin (or a scheduled job) can run an agent turn directly, but a raw
`agent.generate(prompt)` loses everything the HTTP middleware stamps - most
visibly the AppKit user, which every user-scoped tool reads. `ask_genie` then
fails with "invoke the tool from an agent turn served by the mastra plugin", so
the turn answers "the data source is unreachable" where the chat routes answer
with real data.

`exports().createRequestContext()` builds the missing context:

```ts
const mastra = context.getPlugins()?.get("mastra")?.exports();
const requestContext = await mastra.createRequestContext({
  threadId: conversationId,
  resourceId: userId,
});
const result = await mastra.getDefault().generate(prompt, { requestContext });
```

The AppKit user, the memory thread / resource pair, and a request id (so the
turn's spans join up in traces) are stamped exactly as the request middleware
stamps them. Call it inside an `asUser(req)` scope to inherit the caller's OBO
identity; outside one it resolves to the service principal.
[`@dbx-tools/teams`](../teams) uses this so a Teams card turn has the same tool
reach - and therefore the same answer - as a chat turn.

## API Gate

The stock `@mastra/express` app has broad management routes. The plugin's
default `apiAccess: "scoped"` allows only the chat, read-only metadata,
plugin-owned `/route/*`, embed, model, suggestion, and MCP surfaces that the
client needs. Use `apiAccess: "full"` only for a trusted first-party console.

`server.isMastraRequestAllowed()` is exported for tests and custom dispatch
logic that need the same allowlist.

## Routes

Mounted under the plugin base path, which is `/api/mastra` unless you override
`name`. Every route below is registered through AppKit's `route()` helper, so it
appears in the plugin's endpoint map and forwards handler errors to AppKit.

| Method                     | Path                        | Purpose                                                                                     |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `GET`                      | `/models`                   | Serving-endpoint catalogue for a model picker.                                              |
| `GET`                      | `/default-model[/:agentId]` | Static default model an agent falls back to, with its humanized label. `404` on unknown id. |
| `GET`                      | `/suggestions[/:agentId]`   | Starter questions from the configured Genie spaces. Degrades to `[]`.                       |
| `GET`                      | `/embed/chart/:id`          | Long-polls a `[chart:<id>]` marker's cached spec. `?timeoutMs=` up to 5 minutes.            |
| `GET`                      | `/embed/data/:id`           | Rows behind a `[data:<statement_id>]` marker. `?limit=` clamped server-side.                |
| `GET` / `DELETE`           | `/route/history[/:agentId]` | Load or clear the caller's thread messages.                                                 |
| `GET` / `DELETE` / `PATCH` | `/route/threads[/:agentId]` | List, delete, or rename the caller's conversations.                                         |
| `POST`                     | `/route/feedback`           | Log a thumbs / comment assessment to the turn's MLflow trace. `404` when feedback is off.   |
| `POST` / `GET`             | `/mcp`, `/sse`, `/messages` | MCP transports, when `mcp` is enabled.                                                      |

Agent inference itself rides the stock Mastra routes (`/agents/:id/stream`), so
`@mastra/client-js` and `@dbx-tools/ui-mastra` work without a bespoke protocol.

## Environment Variables

Every value can also be set through plugin config, which wins. These are the
fallbacks, so a deployment that already follows AppKit's Databricks env naming
needs no extra wiring.

| Variable                                                            | Effect                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DATABRICKS_SERVING_ENDPOINT_NAME`                                  | Model used when neither the agent nor `defaultModel` names one.                                                         |
| `DATABRICKS_GENIE_SPACE_ID`                                         | Genie space registered under the `default` alias.                                                                       |
| `MASTRA_GENIE_IDENTITY`                                             | `user` (default, OBO), `service-principal`, or `auto` for the agents' Databricks calls.                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Presence of either turns Mastra tracing on when `observability` is unset. On Apps, the telemetry sidecar injects these. |
| `OTEL_PROPAGATORS`                                                  | Set to `none` on Databricks Apps so ingress `traceparent` does not hide every chat trace from UC `*_trace_unified`.     |
| `MLFLOW_EXPERIMENT_ID`, `MLFLOW_EXPERIMENT_NAME`                    | With an OTLP endpoint, turns MLflow feedback on when `feedback` is unset.                                               |

## Configuration Reference

The plugin config is intentionally centered on the AppKit lifecycle instead of
requiring callers to assemble a Mastra server by hand.

- `agents` registers a single agent, an array, or a record keyed by stable agent
  ids. Records are best for UIs because the ids become route-visible.
- `defaultAgent` controls which registered agent handles requests that do not
  name an agent explicitly.
- `storage` and `memory` accept `true`, `false`, or concrete Mastra Postgres /
  PgVector options. `true` resolves from `lakebase()` when present.
- `remoteSkills` provisions `SKILL.md` sources from outside the workspace at
  startup (see [Remote Skills](#remote-skills)). Accepts a single source, a
  list, or an options bag with `failOnError`, `userEmail`,
  `databricksBasePath`, and `refreshTtlMs` (how long a provisioned tree is
  reused before re-downloading, a day by default). A source is `"aitools"` (see
  [Databricks AI Tools](#databricks-ai-tools)) or any URL-like.
- `genieSpaces` maps aliases to Genie Space IDs (or to
  `{ spaceId, hint }` objects). Those aliases flow into tool names,
  suggestions, and chart/data workflows. An alias present with no space id is a
  wiring contradiction and fails at construction rather than silently
  registering no Genie tools.
- `defaultModel`, `modelOverride`, and `modelFuzzyMatch` control how loose model
  names are resolved through Databricks Model Serving.
- `feedback` controls whether MLflow feedback routes are exposed. The automatic
  mode enables feedback when tracing and an MLflow experiment are configured.
- `mcp` controls whether agents are exposed as MCP tools and how that server is
  named.
- `genieIdentity` picks the Databricks identity the agents' workspace calls run
  as - the serving catalogue behind the model picker, Genie suggestions,
  `ask_genie`, and the statement fetch behind a `[data:<id>]` embed. `"user"`
  (default) is always on-behalf-of the signed-in user, so callers must be
  members of the WORKSPACE, not just the Databricks account. `"service-principal"`
  runs those calls as the app service principal instead, so any caller who can
  open the app works even without workspace membership - useful when an app is
  shared with an account-level group too large to add to the workspace. It
  changes only the Databricks credential: memory threads, the per-user cache
  namespace, and trace metadata still key off the forwarded user, at the cost
  of per-user attribution in Genie / Unity Catalog. `"auto"` decides PER REQUEST:
  OBO when the request actually carries an OBO token, service principal when it
  does not. That is the mode for an app served through more than one door - a
  container fronted by [`@dbx-tools/cli-tunnel`](../../cli/tunnel) serves both
  email-code callers (no Databricks credential exists to forward) and the
  platform front door on one port, and `"user"` would make every tunnel turn fail
  with AppKit's `AuthenticationError` while `"service-principal"` would throw away
  per-user scoping for the front-door callers who still have it. Falls back to
  `MASTRA_GENIE_IDENTITY`. The decision itself lives in
  [`@dbx-tools/appkit`](../appkit)'s `identity` module, so a non-Mastra plugin can
  make the same call.
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
  overrides, serving-endpoint config, and the on-the-wire request/response
  cleanup that keeps provider-specific payload quirks (Claude's replayed
  thinking blocks, Gemini's content-parts responses) from failing a turn.
- `genie` - Genie prompt, space normalization, Genie toolkits, and suggestions.
- `chart` / `statement` / `writer` - chart cache, statement row fetches, and
  safe writer events.
- `history` / `threads` / `pagination` / `validation` - conversation persistence
  helpers, route handlers, and request-body validation.
- `defaults` - cache / retry / timeout settings for the plugin's own outbound
  calls, one constant per call site with its reasoning.
- `style` - `TYPOGRAPHY_RULE`, the one no-emoji / no-em-dash sentence the agent
  style block, the summarizer, and the thread titler all append, so a summary or
  a thread title cannot drift from the prose it sits beside.
- `memory` / `storageSchema` - Lakebase-backed Mastra store/vector setup.
- `workspaces` / `filesystems` - Mastra workspace creation with named
  `skillFolders` (defaults `workspace-team` / `workspace-team-app`, overridable
  by consumers); `filesystems(fs)` wraps any `@dbx-tools/shared-fs`
  `FileSystem` (including `@dbx-tools/databricks` / `@dbx-tools/fs`) as a
  Mastra mount, with `scratchFilesystem` (fresh `tmpFS` + random id) when no
  other mount resolves.
- `remote-skills` - startup provisioning of remote `SKILL.md` sources into the
  Databricks Assistant skills tree (or a local temp dir): the `"aitools"`
  constant reads Databricks' own skill repo directly, and any other source goes
  through the optional `skills` CLI or a direct fetch. Each tree carries a
  `.metadata.json` so a source is re-downloaded at most once a day
  (`refreshTtlMs`).
- `mcp` - MCP server construction.
- `observability` / `mlflow` / `traceIo` - tracing, feedback, and stamping chat
  turn I/O onto the HTTP root span for MLflow's UC `*_trace_unified` view.
- `server` / `rest` / `processors` - Express dispatch, Databricks REST helpers,
  stream/result processors.

Browser-facing wire types are in
[`@dbx-tools/shared-mastra`](../../shared/mastra). Genie event contracts are in
[`@dbx-tools/shared-genie`](../../shared/genie). Model request/result contracts
are in [`@dbx-tools/shared-model`](../../shared/model). The matching React chat
surface is [`@dbx-tools/ui-mastra`](../../ui/mastra).
