# @dbx-tools/appkit-mastra

AppKit plugin and server-side toolkit for hosting Mastra agents inside a
Databricks App.

The plugin mounts Mastra's streaming routes in an AppKit server and adds
Databricks authentication, Lakebase-backed memory, Genie tools, model selection,
chart and table embeds, MLflow feedback, and MCP exposure.

## Quick Start

Add an agent and run its command tools in a per-user Databricks Sandbox:

```ts
import { createApp, server } from "@databricks/appkit";
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const analyst = agents.createAgent({
  instructions: "Answer questions and use Python when analysis requires it.",
});

await createApp({
  plugins: [server(), mastra({ agents: { analyst }, sandbox: "databricks" })],
});
```

Add Lakebase, Genie, Analytics, or other AppKit plugins when the agent needs
durable threads or workspace tools.

## Choose Mastra Or AppKit Agents

Native AppKit Agents is the shorter path for AppKit-native agent definitions,
streaming chat, threads, cancellation, and approvals. Choose this package when
the application already uses Mastra or needs Mastra-specific capabilities:

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

## Full App Example

```ts
import { analytics, createApp, lakebase, server } from "@databricks/appkit";
import { agents, genie, mastra } from "@dbx-tools/appkit-mastra";
import { z } from "zod";

const analyst = agents.createAgent({
  name: "analyst",
  instructions: ["You answer questions about workspace data.", genie.GENIE_INSTRUCTIONS].join(
    "\n\n",
  ),
  async tools(plugins) {
    const [analyticsTools, genieTools] = await Promise.all([
      plugins.analytics.toolkit(),
      plugins.genie?.toolkit(),
    ]);
    return {
      ...analyticsTools,
      ...genieTools,
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
    mastra({
      agents: { analyst },
      defaultAgent: "analyst",
      genieSpaces: { sales: "01ef..." },
    }),
  ],
});
```

This example provides:

- `mastra()` registers a full AppKit plugin named `mastra`.
- `agents.createAgent()` keeps agent definitions typed and applies the default
  Databricks workspace skill paths and Monty command execution.
- `agents.tool()` lets the same AppKit-shaped tool body work in this Mastra
  plugin.
- `genie.GENIE_INSTRUCTIONS` and `plugins.genie.toolkit()` give agents a
  Databricks Genie workflow without embedding a second agent.
- Lakebase registration automatically enables durable thread storage and vector
  memory unless you opt out.

## Agent Registration

`mastra({ agents })` accepts a single definition, an array, or a record.
Records are best when clients need stable agent ids:

```ts
mastra({
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

Agents are also told to issue independent tool calls together in one turn and
to keep dependent or conflicting calls sequential. Models that do not support
parallel tool calls continue through the normal multi-step agent loop.

## Typed Application Request Context

Use Mastra's native `requestContextSchema` for UI selections that should shape a
turn, such as a store, workflow, route, or selected entity:

```ts
const StoreContextSchema = z.object({
  storeId: z.string(),
  route: z.string(),
});
type StoreContext = z.infer<typeof StoreContextSchema>;

const analyst = agents.createAgent<StoreContext>({
  name: "analyst",
  requestContextSchema: StoreContextSchema,
  instructions: ({ requestContext }) =>
    `Help with store ${requestContext.get("storeId")} on ${requestContext.get("route")}.`,
  tools: {
    inspect_store: agents.createTool({
      id: "inspect_store",
      description: "Inspect the selected store.",
      inputSchema: z.object({}),
      requestContextSchema: StoreContextSchema,
      execute: async (_input, context) => ({
        storeId: context.requestContext?.get("storeId"),
      }),
    }),
  },
});
```

The paired UI sends this through Mastra's standard `requestContext` body field.
The agent schema validates it before model execution. AppKit-Mastra removes and
re-stamps trusted identity, resource, thread, auth, scope, model, and trace keys,
so application context cannot change conversation ownership or credentials.

`createAgent({ requireToolApproval })` forwards Mastra's native request-level
approval gate. It may be an async Classifier-backed function that returns `true`
for calls still needing human review. A tool's own `requireApproval` remains
authoritative; configure that native function on the tool when policy should
allow some calls. Regular agents do not include Agent Controller's durable
allow/ask/deny permission store, so remembered decisions remain a caller-owned,
server-side durable policy rather than browser state.

## AppKit Toolkits

The `tools(plugins)` callback receives a dynamic index of registered AppKit
tool-provider plugins. Each entry exposes `.toolkit(opts)` with AppKit's public
`prefix`, `only`, `except`, and `rename` contract. Await toolkit resolution so
providers backed by asynchronous discovery can finish registration. Providers
that expose only AppKit's native `getAgentTools()` and `executeAgentTool()` are
adapted too. Routine `effect: "write"` and `effect: "update"` annotations remain
mutation metadata and do not automatically suspend a Mastra run. The adapter
requires approval only for `effect: "destructive"` or the
`destructive: true` annotation. Tools needing stricter policy set Mastra's
`requireApproval` explicitly.

```ts
const agent = agents.createAgent({
  instructions: "Use the narrowest tool that answers the question.",
  async tools(plugins) {
    const [analyticsTools, fileTools] = await Promise.all([
      plugins.analytics.toolkit({ only: ["query"] }),
      plugins.files?.toolkit({ prefix: "files.", except: ["delete"] }),
    ]);
    return {
      ...analyticsTools,
      ...fileTools,
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
mastra({
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
`workspaces.databricksWorkspace()`. Most apps do not need workspace
configuration: the default scans `/Workspace/.assistant/skills` and the current
user's `~/.assistant/skills` path for `SKILL.md` files.

Pass paths directly when an agent needs a different filesystem scope:

```ts
const analyst = agents.createAgent({
  instructions: "Use the project files and skills when relevant.",
  workspace: workspaces.databricksWorkspace({
    assistantPaths: false,
    paths: ["~/project"],
  }),
});
```

Paths mount at the same absolute path that they identify. `~` resolves to the
current user's Databricks workspace home, so `~/project` exposes only that
subtree. A path that is missing or inaccessible for the current request is
skipped. Production Databricks mounts require a forwarded token with
`workspace`, `workspace.workspace`, or `all-apis` scope.

Use an options object only when a path needs additional behavior:

```ts
const workspace = workspaces.databricksWorkspace({
  assistantPaths: false,
  paths: [
    {
      path: "/Workspace/Shared/runbooks",
      skills: ["skills"],
      writable: true,
      createRoot: false,
    },
    {
      path: "/Workspace/Shared/templates",
      readable: false,
    },
    ({ requestContext }) =>
      requestContext.get("team") === "platform" ? "~/platform" : false,
  ],
});
```

`readable: false` keeps a mount available to file tools without scanning it for
skills. `skills` contains relative roots within that path. `writable` controls
whether the filesystem attempts mutations; Databricks permissions still decide
whether an operation succeeds. `mount` can expose the path at a different
Mastra path when required.

`/tmp` is opt-in. An explicit `/tmp` path maps to a stable user-scoped directory
under the host operating system's ephemeral temp location. `/tmp/project` maps
to a child directory and exposes only `/tmp/project`, not the rest of `/tmp`.
The location can survive process restarts while the host retains its temp
storage, but it is not durable storage.

The shortcut returns a native Mastra workspace and accepts native `mounts`,
`tools`, and workspace options. Use the config helper when composing the result
with another Mastra provider:

```ts
import { Workspace } from "@mastra/core/workspace";

export const workspace = new Workspace({
  ...workspaces.databricksWorkspaceConfig({
    assistantPaths: false,
    paths: ["~/project", "/tmp/project"],
  }),
  sandbox: mySandbox,
});
```

Mastra discovers and loads skills from the configured roots. Set
`workspaceSkills: false` to disable skill search, or pass `{ topK, minScore,
ttlMs }` to tune it.

### Cache Workspace Metadata

Register `filesCache()` to reuse Databricks directory metadata across page
refreshes and later turns:

```ts
import { filesCache } from "@dbx-tools/appkit/files-cache";

await createApp({
  plugins: [server(), filesCache(), mastra({ agents: { analyst } })],
});
```

The cache is isolated by user and mount path. It stores `exists`, `readdir`, and
`stat` results for mounted Databricks paths and caches `readFile` only under
skill roots. Set `cache: false` to disable it or provide filters:

```ts
const workspace = workspaces.databricksWorkspace({
  paths: ["~/project"],
  cache: [
    { operations: ["exists", "readdir", "stat"], paths: "**" },
    { operations: "readFile", paths: "~/project/skills/**" },
  ],
});
```

### Configure File Approvals

Workspace tools are enabled and run without approval by default. This applies to
file mutations and command execution with either Monty or Databricks Sandbox.
Databricks permissions still decide whether a workspace file operation
succeeds. Opt into approval for the tools that need it:

```ts
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";

const workspace = workspaces.databricksWorkspace({
  paths: ["~/project"],
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});
```

Set `enabled: false` on a tool to remove it. File approvals and sandbox commands
are separate, so gate or disable
`WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND` when commands must not bypass file
policies. Cached metadata never grants Databricks access.

## Workspace Sandbox

Run command tools in a per-user Beta
[Databricks Sandbox](https://docs.databricks.com/aws/en/compute/serverless/sandbox):

```ts
mastra({
  agents: { analyst },
  sandbox: "databricks",
});
```

Use `sandbox: true` for the same selection. Pass options to set startup and
command limits or to fall back to the local Python runtime when the workspace
does not have the preview:

```ts
mastra({
  agents: { analyst },
  sandbox: {
    inactivityTimeout: "1800s",
    startupTimeoutMs: 180_000,
    commandTimeoutMs: 60_000,
    fallback: "monty",
  },
});
```

The sandbox is created on the first command and reused for the attributed user.
Commands return the normal Mastra stdout, stderr, exit, timeout, and truncation
fields. Authentication, permission, and network failures are returned to the
caller; only a definitive unavailable-preview response uses the configured
fallback.

Enable Databricks Sandbox in the workspace Previews page before selecting it.
The adapter creates its own AppKit client through the normal
environment/profile chain, so a Databricks App uses its service principal even
when the agent turn uses OBO. Databricks Apps user authorization does not
currently expose the Sandbox API scope. Outside Apps, a caller that supplies an
explicit OBO client must request the Sandbox API's `sandbox` scope. The Sandbox
filesystem is separate from Databricks Workspace skill mounts; command code must
copy data explicitly when it needs both.

Without a `sandbox` option, command tools use the local Monty Python runtime:

```ts
mastra({
  agents: analyst,
});
```

Monty accepts Python source or `python3 -c` and has no host filesystem, network,
environment variables, shell, or third-party packages. Use Python source when a
command must work with either provider.

Disable command execution, select Databricks, or provide any Mastra sandbox on
one agent:

```ts
mastra({ agents: analyst, sandbox: false });
mastra({ agents: analyst, sandbox: "databricks" });

const localAgent = agents.createAgent({
  instructions: "Run only trusted local commands.",
  workspace: workspaces.databricksWorkspace({
    sandbox: myMastraSandbox,
  }),
});
```

An agent-level workspace overrides the plugin-level sandbox setting. Returning
`undefined` from a workspace resolver disables the workspace for that agent.

## Remote Skills

Use `remoteSkills` to install a curated skill set when the files are not already
in the Databricks workspace. Sources can be a GitHub `owner/repo`, a git URL, a
direct `SKILL.md`, or an archive URL.

```ts
mastra({
  agents: { assistant: agents.createAgent({ instructions: "..." }) },
  remoteSkills: [
    "owner/skill-repo",
    { source: "https://example.com/skills/writing.md", failOnError: false },
  ],
});
```

Each source is copied into an Assistant-style `SKILL.md` tree at startup. Install
the optional `skills` package for GitHub shorthand, git repositories, and archive
URLs:

```sh
bun add skills
```

Without that package, direct `SKILL.md` URLs still work.

The default destination is `/Workspace/.assistant/skills`. Set `userEmail` for a
user-specific Assistant tree or `databricksBasePath` for another location. If
the app cannot write the selected workspace path, it uses a process-local skill
tree so the agent can still start. Grant the app service principal access to the
workspace path when the skills must persist across restarts.

A source error fails startup by default. Set `failOnError: false` globally or on
one source to log and skip it.

### Refresh policy

Downloaded sources are reused for seven days by default. Set `refreshTtlMs` to a
shorter interval or `0` to download on every boot:

```ts
mastra({
  // Re-pull at most once an hour instead of once every seven days.
  remoteSkills: { sources: ["aitools"], refreshTtlMs: 60 * 60 * 1000 },
});

// Per-source, and `0` to download on every boot:
mastra({
  remoteSkills: {
    sources: [{ source: "owner/skill-repo", refreshTtlMs: 0 }, "aitools"],
  },
});
```

Changing a source's `skills`, `experimental`, or `ref` option refreshes it
immediately.

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

`ask_genie` uses the Genie Agent Mode SSE API by default, projecting reasoning,
SQL function calls, query output, and the synthesized answer into the existing
writer events and terminal `GenieMessage`. Set `genieAgentMode: false` on
`mastra(...)` to force the Conversation API polling flow. A pre-stream
`FEATURE_DISABLED` or preview-toggle error falls back to polling automatically.
Agent Mode carries query results inline as Markdown; use polling when a workflow
specifically requires `statement_id`-backed chart or data embeds. For
Agent Mode charts, pass the inline Markdown or structured metadata rows to the
auto-wired `render_data` tool; never pass response, conversation, or function
call ids to `prepare_chart`.

```ts
const agent = agents.createAgent({
  instructions: `${baseInstructions}\n\n${genie.GENIE_INSTRUCTIONS}`,
  async tools(plugins) {
    return { ...(await plugins.genie?.toolkit({ prefix: "" })) };
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
Genie supplies those statement ids through the Conversation API polling
transport; Agent Mode returns inline Markdown and structured table metadata
instead. The
`GENIE_INSTRUCTIONS` prompt directs Agent Mode turns to call `render_data` with
those inline rows, while polling turns call `prepare_chart` only with a real
statement id.

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
import { brandUtils } from "@dbx-tools/shared-core";

mastra({ agents, storage: true, brand: brandUtils.defaultBrandContext });
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
5. highest-ranked currently available GPT from the live workspace catalogue,
   then the highest-ranked live chat model when no GPT is deployed.

The unconfigured default is live-only and fails clearly when the workspace has
no usable endpoint. Static fallback ids remain available for explicitly
configured classes or fallback policy, but are never advertised as an available
automatic default without a catalogue match.

```ts
mastra({
  agents: analyst,
  defaultModel: "claude sonnet",
  modelFuzzyMatch: true,
  modelOverride: true,
});
```

Use `serving.extractModelOverride()` and `serving.resolveServingConfig()` when
building custom routes that should behave like the plugin's `/models` and stream
routes.

The serving fetch interceptor repairs provider-specific wire requirements for
both `fetch(url, { body })` and `fetch(new Request(...))`. In particular,
Databricks-hosted GPT 5.6 Chat Completions with function tools receives
`reasoning_effort: "none"` even when a caller default selected another effort.
Other Chat models receive no synthesized effort, while an explicit supported
caller value is preserved. Responses-only models such as GPT Astra use the
native Responses provider. Claude reasoning replay and Gemini/Claude structured
response content continue through the same sanitizer.

Responses turns set `store: false`. The OpenAI provider automatically includes
encrypted reasoning state so a tool continuation sends the complete stateless
conversation. Databricks does not store Responses and rejects
`item_reference` inputs.

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

## Evaluate In Process

`eval.createMastraEvalDriver()` adapts a Mastra agent's native `generate()`
result to AppKit 0.81's `EvalDriver` contract without reducing a chat stream:

```ts
import { runEval } from "@databricks/appkit/beta";
import { evaluation } from "@dbx-tools/appkit-mastra";

await runEval(definition, {
  driver: evaluation.createMastraEvalDriver(agent),
});
```

The driver keeps multi-turn memory on one thread, forwards timeout
cancellation, reports complete tool names/arguments and trace IDs, and starts a
new thread on `reset()`. It deliberately does not replace production feedback,
MLflow reporting, OTel tracing, or the official AI SDK chat route.

## Feedback And Observability

`observability.buildObservability()` wires Mastra tracing when OTLP export is
configured. `mlflow.resolveFeedbackEnabled()` turns MLflow feedback on when both
trace export and an MLflow experiment are configured, unless the plugin config
forces a value. Explicit `feedback: true` requires `MLFLOW_EXPERIMENT_ID` or
`MLFLOW_EXPERIMENT_NAME` and fails app startup when neither is available. The
plugin also stamps each chat turn's request/response onto
the request's exported root span via `telemetry.attachChatTurnTelemetry()` so
MLflow's UC `*_trace_unified` view can show them. It uses AppKit's HTTP server
span when present and creates one request-lifetime fallback span otherwise.
Mastra's own `mastra.agent_run.*` attributes sit on a child span that the view
never reads. Text-only turns use raw prompt and answer previews, while
`appkit.mastra.chat.messages` and `appkit.mastra.chat.response` retain the
serialized envelopes. `appkit.mastra.identity.mode` records `obo` versus
`service-principal`. The experiment UI's User and Tags columns read the OTel
attributes Databricks documents for inbound traces: `user.id` (forwarded email
or user id), `session.id` (Mastra thread id), `mlflow.spanType` (`AGENT` on the
root, `GENIE` on `ask_genie`), `mlflow.traceTag.agent=<first model id>` on every
chat, and `mlflow.traceTag.genie=true` when the turn called Genie. Model changes
later in the turn do not replace the `agent` tag, and no separate `model` tag is
written. `obo_auth=true` and `sp_auth=true` independently record whether each
Databricks authentication mode was invoked during the turn, so a mixed-auth
turn keeps both tags. `local=true` is added automatically when
`isDatabricksAppEnv()` is false. The `@dbx-tools/tunnel` AppKit plugin injects
`tunnel=portr|frp` and `tunnel_subdomain=<name>` through AppKit's generic
request-tag context when the public host matches its tunnel configuration.
Other AppKit plugins can use `injectRequestTag(s)`, and direct middleware callers
can seed `ChatTurnTelemetryOptions.tags`; package and application code can then
add or replace tags anywhere inside the active request with
`recordActiveTraceTag(name, value)` or `recordActiveTraceTags({ name: value })`.
The reserved `mlflow.traceTag.` prefix persists these as trace tags rather than
ordinary span metadata.
`appkit.mastra.genie.used` remains as a searchable custom attribute.

```ts
mastra({
  agents: analyst,
  feedback: true,
});
```

`mlflow.logFeedback()` logs a human assessment against the active MLflow trace.
On Apps UC traces it reads the experiment's
`mlflow.experiment.databricksTraceDestinationPath` tag (or the spans-table tag)
so the assessment URI matches the row the experiment UI shows. The response
header name and request/response schemas live in
[`@dbx-tools/shared-mastra`](../../shared/mastra).

Outside a Databricks App, an experiment id automatically enables direct MLflow
tracing. The plugin initializes the MLflow Node SDK, injects
`DATABRICKS_CONFIG_PROFILE` into a `databricks://<profile>` tracking URI, and
auto-detects the experiment's UC trace location. `MLFLOW_UC_TRACE_PREFIX` or the
`MLFLOW_UC_CATALOG` / `MLFLOW_UC_SCHEMA` / `MLFLOW_UC_TABLE_PREFIX` trio can
override that location. The local provider forwards only marked chat roots and
their descendants, so unrelated AppKit HTTP, cache, and plugin spans
do not become traces. Before export it also writes the resolved email, user
name, or resource id to MLflow's trace user field. Direct mode requires a
UC-linked experiment. Inside a Databricks App (`isDatabricksAppEnv()`), this
provider stays off so AppKit remains the single global OTel provider and the
platform telemetry sidecar owns export.

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
          # discards every chat turn. appkit-mastra applies this setting after
          # AppKit starts, before the server accepts requests.
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
mastra({
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
`name`. Product-specific routes use AppKit's `route()` helper; chat and memory
use Mastra's native route surfaces behind the same scoped request-context gate.

| Method                     | Path                              | Purpose                                                                                                                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET`                      | `/models`                         | Serving-endpoint catalogue for a model picker.                                                                           |
| `GET`                      | `/default-model[/:agentId]`       | Configured default, or highest-ranked live GPT with a general chat fallback, for an unpinned agent. `404` on unknown id. |
| `GET`                      | `/suggestions[/:agentId]`         | Starter questions from the configured Genie spaces. Degrades to `[]`.                                                    |
| `GET`                      | `/embed/chart/:id`                | Long-polls a `[chart:<id>]` marker's cached spec. `?timeoutMs=` up to 5 minutes.                                         |
| `GET`                      | `/embed/data/:id`                 | Rows behind a `[data:<statement_id>]` marker. `?limit=` clamped server-side.                                             |
| `POST`                     | `/chat/:agentId`                  | Official Mastra AI SDK UI stream, including native `resumeData` continuations.                                           |
| `GET` / `PATCH` / `DELETE` | `/memory/threads[...]`            | Native Mastra resource-scoped conversation history and thread management.                                                |
| `POST`                     | `/memory/messages/delete`         | Native message deletion used before regenerating a response.                                                             |
| `GET`                      | `/agents/:agentId/suspended-runs` | Native persisted approval discovery after a reload or restart.                                                           |
| `POST`                     | `/route/feedback`                 | Log a thumbs / comment assessment to the turn's MLflow trace. `404` when feedback is off.                                |
| `GET`                      | `/route/mlflow-experiment`        | Return the experiment URL only when the active viewer has effective `CAN_MANAGE`; otherwise `{ "url": null }`.           |
| `POST` / `GET`             | `/mcp`, `/sse`, `/messages`       | MCP transports, when `mcp` is enabled.                                                                                   |

The UI consumes `/chat/:agentId` with the AI SDK's `DefaultChatTransport`.

## Environment Variables

Every value can also be set through plugin config, which wins. These are the
fallbacks, so a deployment that already follows AppKit's Databricks env naming
needs no extra wiring.

| Variable                                                            | Effect                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABRICKS_SERVING_ENDPOINT_NAME`                                  | Optional model override used when neither the agent nor `defaultModel` names one; omit for live highest-rank selection.                            |
| `DATABRICKS_GENIE_SPACE_ID`                                         | Genie space registered under the `default` alias.                                                                                                  |
| `MASTRA_GENIE_IDENTITY`                                             | `user` (default, OBO), `service-principal`, or `auto` for the agents' Databricks calls.                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Presence of either turns Mastra tracing on when `observability` is unset. On Apps, the telemetry sidecar injects these.                            |
| `OTEL_PROPAGATORS`                                                  | Set to `none` on Databricks Apps. The plugin disables extraction and injection before serving requests while retaining local async span parenting. |
| `MLFLOW_EXPERIMENT_ID`, `MLFLOW_EXPERIMENT_NAME`                    | With an OTLP endpoint, turns MLflow feedback on when `feedback` is unset. Assessments read the experiment's UC trace destination tag.              |
| `MLFLOW_UC_TRACE_PREFIX`                                            | Optional override for the UC table prefix. Omit to use the experiment tag.                                                                         |

## Configuration Reference

The main plugin options are:

- `agents` registers a single agent, an array, or a record keyed by stable agent
  ids. Records are best for UIs because the ids become route-visible.
- `defaultAgent` controls which registered agent handles requests that do not
  name an agent explicitly.
- `storage` and `memory` accept `true`, `false`, or concrete Mastra Postgres /
  PgVector options. `true` resolves from `lakebase()` when present.
- `sandbox` defaults to Monty for auto-created workspaces. `false` disables
  command execution, while `true`, `"databricks"`, or an object
  selects/configures Databricks Sandbox.
- `workspaceSkills` enables Mastra's native on-demand skill search by default.
  Pass `false` to disable it or an object with `topK`, `minScore`, and `ttlMs`
  overrides.
- `workspaceTools` forwards Mastra's native workspace-tool configuration.
  All tools are enabled without approval by default. Global and per-tool
  settings can require approval or disable selected tools.
- `remoteSkills` provisions `SKILL.md` sources from outside the workspace at
  startup (see [Remote Skills](#remote-skills)). Accepts a single source, a
  list, or an options bag with `failOnError`, `userEmail`,
  `databricksBasePath`, and `refreshTtlMs` (how long a provisioned tree is
  reused before re-downloading, seven days by default). A source is `"aitools"` (see
  [Databricks AI Tools](#databricks-ai-tools)) or any URL-like.
- `genieSpaces` maps aliases to Genie Space IDs (or to
  `{ spaceId, hint }` objects). Those aliases flow into tool names,
  suggestions, and chart/data workflows. Every configured alias needs a space
  id.
- `genieAgentMode` defaults to `true` for the streaming Agent Mode API. Set it
  to `false` to force Conversation API polling. Pre-stream feature-disabled or
  preview-toggle responses fall back automatically.
- `defaultModel`, `modelOverride`, and `modelFuzzyMatch` control how loose model
  names are resolved through Databricks Model Serving.
- `feedback` controls whether MLflow feedback routes are exposed. The automatic
  mode enables feedback when tracing and an MLflow experiment are configured.
  Explicit `true` fails startup unless an experiment id or name is configured.
- `mcp` controls whether agents are exposed as MCP tools and how that server is
  named.
- `genieIdentity` selects credentials for model discovery, Genie calls, and
  statement fetches. `"user"` uses OBO and requires workspace membership.
  `"service-principal"` lets account-level users call the app without workspace
  membership. `"auto"` uses OBO when the request includes it and otherwise uses
  the service principal. Memory threads, cache namespaces, and trace metadata
  remain user-scoped in all three modes. The environment fallback is
  `MASTRA_GENIE_IDENTITY`.
- `apiAccess` chooses the route allowlist. Keep the default scoped mode for
  deployed apps.

Clients that call these routes can import the browser-safe schemas from
[`@dbx-tools/shared-mastra`](../../shared/mastra).

## Modules

- `plugin` - `MastraPlugin` and `mastra()` AppKit plugin factory.
- `evaluation` - in-process AppKit `EvalDriver` over Mastra `Agent.generate()`.
- `agents` - `createAgent`, `tool`, `createTool`, agent build helpers, fallback
  defaults, and approval-gated tool inspection.
- `config` - plugin config types and RequestContext key constants.
- `model` / `serving` / `servingSanitize` - Mastra model config, request
  overrides, serving-endpoint config, and the on-the-wire request/response
  cleanup that keeps provider-specific payload quirks (GPT 5.6 Chat tool
  reasoning, Claude's replayed thinking blocks, Gemini/Claude content-parts
  responses) from failing a turn.
- `genie` - Genie prompt, space normalization, Genie toolkits, and suggestions.
- `chart` / `statement` / `writer` - chart cache, statement row fetches, and
  safe writer events.
- `validation` - request-body validation for the plugin's custom routes.
- `defaults` - cache / retry / timeout settings for the plugin's own outbound
  calls, one constant per call site with its reasoning.
- `style` - `TYPOGRAPHY_RULE`, the one no-emoji / no-em-dash sentence the agent
  style block, the summarizer, and the thread titler all append, so a summary or
  a thread title cannot drift from the prose it sits beside.
- `memory` / `storageSchema` - Lakebase-backed Mastra store/vector setup.
- `sandbox` - Databricks Sandbox lifecycle, fallback policy, and command-result
  adapter.
- `montySandbox` - Python-only Pydantic Monty fallback using Node subprocess
  workers.
- `workspaces` / `filesystems` - native Mastra workspace configuration from
  Databricks paths, opt-in user-scoped temp paths, and caller-supplied mounts;
  `filesystems(fs)` wraps any `@dbx-tools/shared-fs` `FileSystem` (including
  `@dbx-tools/databricks` / `@dbx-tools/fs`) as a Mastra mount.
- `remote-skills` - startup provisioning of remote `SKILL.md` sources into the
  Databricks Assistant skills tree (or a local temp dir): the `"aitools"`
  constant reads Databricks' own skill repo directly, and any other source goes
  through the optional `skills` CLI or a direct fetch. Each tree carries a
  `.metadata.json` so a source is re-downloaded at most once every seven days
  (`refreshTtlMs`).
- `mcp` - MCP server construction.
- `observability` / `mlflow` / `telemetry` - tracing, feedback, and stamping chat
  turn I/O onto the HTTP root span for MLflow's UC `*_trace_unified` view.
- `server` / `rest` / `processors` - Express dispatch, Databricks REST helpers,
  and stale chart-id input cleanup.

Browser-facing wire types are in
[`@dbx-tools/shared-mastra`](../../shared/mastra). Genie event contracts are in
[`@dbx-tools/shared-genie`](../../shared/genie). Model request/result contracts
are in [`@dbx-tools/shared-model`](../../shared/model). The matching React chat
surface is [`@dbx-tools/ui-mastra`](../../ui/mastra).
