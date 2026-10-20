# @dbx-tools/appkit-mastra

Host Mastra agents in a Databricks App with AppKit authentication, streaming
routes, Lakebase-backed memory, Genie tools, model selection, chart and table
embeds, Genie or MLflow feedback, and MCP exposure.

## Quick start

Add an agent and run its command tools in the default Monty runtime:

```ts
import { createApp, server } from "@databricks/appkit";
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const analyst = agents.createAgent({
  instructions: "Answer questions and use Python when analysis requires it.",
});

await createApp({ plugins: [server(), mastra({ agents: { analyst } })] });
```

Add Lakebase, Genie, Analytics, or other AppKit plugins when the agent needs
durable threads or workspace tools.

## Choose Mastra, AppKit Agents, or direct Genie

Native AppKit Agents is the shorter path for AppKit-native agent definitions,
streaming chat, threads, cancellation, and approvals. Choose this package when
the application already uses Mastra or needs Mastra-specific capabilities:

- Mastra's larger plugin/tool ecosystem, MCP support, memory/storage model,
  workflow primitives, and `@mastra/client-js` stream shape.
- AppKit toolkits as Mastra tools, so Analytics, Files, Genie, and other AppKit
  ToolProvider plugins stay available without rewriting them.
- Genie as an agent tool that emits typed progress events, result metadata, and
  delayed chart/data markers into the same assistant turn.
- A paired React client in [@dbx-tools/ui-mastra](../../ui/mastra) with model
  picking, thread sidebar, approvals, feedback, exports, and inline embeds.
- Per-request model override and fuzzy endpoint resolution through
  [@dbx-tools/model](../model), instead of binding every agent to a fixed
  endpoint name.

Use direct Genie chat when one Genie space owns the conversation and users don't
need a supervising agent. Choose Mastra when one turn must combine Genie with
other tools, approvals, or workflows. Direct Genie keeps conversation history
in Genie and, when Mastra memory is configured, adds resource-scoped semantic
recall and saves completed turns to that memory.

## Full app example

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
  Databricks workspace skill paths. Command execution is opt-in.
- `agents.tool()` lets the same AppKit-shaped tool body work in this Mastra
  plugin.
- `genie.GENIE_INSTRUCTIONS` and `plugins.genie.toolkit()` give agents a
  Databricks Genie workflow without embedding a second agent.
- Lakebase registration automatically enables durable thread storage and vector
  memory unless you opt out.

## Agent registration

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

## Typed application request context

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
The same native context reaches direct Genie chat, where it is supplied as
reference data because the Genie Agent Mode API accepts only one user message.

## Register application workflows

Pass code-defined workflows in plugin config, or let a sibling plugin register
one before AppKit setup completes:

```ts
mastra({
  workflows: { generatorDemoAssets },
});
```

Scoped mode exposes `POST /api/mastra/route/workflows/:workflowId/stream` in AI
SDK v7 format while keeping Mastra's stock workflow administration routes
closed. The route always uses the trusted request context stamped by
AppKit-Mastra. Start and resume requests must provide fresh OBO context because
workspace clients and tokens are never persisted in workflow snapshots.

`createAgent({ requireToolApproval })` forwards Mastra's native request-level
approval gate. It may be an async Classifier-backed function that returns `true`
for calls still needing human review. A tool's own `requireApproval` remains
authoritative. Configure that native function on the tool when policy should
allow some calls. Regular agents do not include Agent Controller's durable
allow/ask/deny permission store, so remembered decisions remain a caller-owned,
server-side durable policy rather than browser state.

## AppKit toolkits

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

Tool calls dispatch back through the owning AppKit plugin, preserving
on-behalf-of-user (OBO) authentication and AppKit telemetry behavior. Optional
plugins should be guarded with `?.` when you spread their tools.

### Tools flow in, not out

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

## Memory and storage

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

- Storage uses a per-agent schema for durable threads and messages.
- Memory uses a shared vector index with resource-scoped semantic recall across
  the caller's threads and agents.
- Direct Genie turns read from and write to the default agent's native memory
  instance while Genie retains its own visible conversation history.
- The existing service-principal pool is captured from `lakebase()` during
  startup, so request-scoped OBO credentials never reach storage work and no
  additional PostgreSQL pool is created.

Without `lakebase()`, agents are stateless unless you provide explicit storage
and memory configs.

### Add external durable memory tools

Register `@dbx-tools/appkit-memory` as a sibling plugin and request
`plugins.memory?.toolkit()` from the agents that need its `remember` and
`recall_memory` tools. The memory plugin owns Databricks and Graphiti selection.
Mastra continues to own only its configured PostgresStore and PgVector.

## Workspace capabilities

Every `agents.createAgent()` gets a default Mastra `Workspace` from
`workspaces.databricksWorkspace()`. A workspace can provide file access, skill
discovery, a command sandbox, or any combination. The default mounts
`/Workspace/.assistant` and the current user's workspace home, scans their
configured Assistant skill paths, and provides Monty for isolated Python
command execution.

Use AppKit's Files plugin when application routes and UI components need
governed upload, download, or volume access. Use a Mastra workspace when the
agent itself needs files, skills, or command execution during a turn. A
`FileSystem` from [@dbx-tools/databricks](../databricks) or
[@dbx-tools/fs](../fs) can be mounted into that workspace with
`filesystems(fs)`.

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
    },
    ({ requestContext }) => (requestContext.get("team") === "platform" ? "~/platform" : false),
  ],
});
```

Paths are file-only unless `skills` lists relative Mastra skill paths within
that included path. At workspace level, `skills` uses Mastra's native path list
or resolver. An empty list retains configured mounts without exposing skills.
`writable` controls whether the filesystem attempts mutations. Databricks
permissions still decide whether an operation succeeds. `mount` can expose the
path at a different Mastra path when required.

Configure the capabilities independently:

```ts
const filesOnly = workspaces.databricksWorkspace({
  assistantPaths: false,
  paths: ["~/project"],
  sandbox: false,
});

const skillsOnly = workspaces.databricksWorkspace({
  sandbox: false,
  tools: { enabled: false },
});

const sandboxOnly = workspaces.databricksWorkspace({
  assistantPaths: false,
  skills: [],
  tools: {
    enabled: false,
    mastra_workspace_execute_command: { enabled: true },
  },
});
```

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

Mastra discovers skills from explicit `skills` paths, including the paths
declared under the default Assistant paths and read-only `localSkillMounts`.
Those paths use the skill-search processor. Set `workspaceSkills: false` to
omit that processor, or pass `{ topK, minScore, ttlMs }` to tune it. Local
mounts are also passed as native agent-level skills, so the standard `skill`,
`skill_search`, and `skill_read` tools remain available. Startup-provisioned
remote skills use their native tools without duplicating their virtual mounts
in workspace search. Set the workspace's `skills` to an empty list when the
workspace should expose no skills.

### Cache workspace metadata

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
skill paths. Set `cache: false` to disable it or provide filters:

```ts
const workspace = workspaces.databricksWorkspace({
  paths: ["~/project"],
  cache: [
    { operations: ["exists", "readdir", "stat"], paths: "**" },
    { operations: "readFile", paths: "~/project/skills/**" },
  ],
});
```

### Configure file approvals

Workspace tools are enabled and run without approval by default. This applies to
file mutations and command execution with either Monty or a supplied sandbox
transport. Databricks permissions still decide whether a workspace file
operation succeeds. Opt into approval for the tools that need it:

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

## Workspace sandbox

Auto-created workspaces use Monty by default. Supply any native Mastra
`WorkspaceSandbox` or request-scoped resolver to use a remote transport:

```ts
const remoteSandbox = ({ requestContext }) => resolveRemoteSandbox(requestContext);

mastra({
  agents: { analyst },
  sandbox: remoteSandbox,
});
```

For a Databricks Lakebox, use `lakeboxWorkspaceSandbox(runtime)` from
`@dbx-tools/appkit-lakebox/workspace`. Share that runtime with the Lakebox
AppKit plugin so agent commands, terminals, desktops, and service routes use the
same Lakebox and per-user account. That package owns Lakebox lifecycle, SSH
keys, user accounts, and route forwarding. Its Mastra adapter forwards command
output to `onStdout` and `onStderr` while the command runs, then returns
Mastra's completed `CommandResult`.

The default local Monty Python runtime accepts Python source or `python3 -c` and
has no host filesystem, network, environment variables, shell, or third-party
packages. Use Python source when a command must work with either provider.

Select Monty explicitly when replacing another plugin-level sandbox setting:

```ts
mastra({
  agents: analyst,
  sandbox: "monty",
});
```

Disable command execution or provide any Mastra sandbox on one agent:

```ts
mastra({ agents: analyst, sandbox: false });
mastra({ agents: analyst, sandbox: remoteSandbox });

const localAgent = agents.createAgent({
  instructions: "Run only trusted local commands.",
  workspace: workspaces.databricksWorkspace({
    sandbox: myMastraSandbox,
  }),
});
```

An agent-level workspace overrides the plugin-level sandbox setting. Returning
`undefined` from a workspace resolver disables the workspace for that agent.

### Batch tools with Code Mode

Mastra Code Mode is disabled by default. Enable it explicitly to add an
`execute_typescript` tool so the model can batch independent calls, aggregate
their results, and perform calculations in one isolated program. Agent,
plugin-level, and enabled native workspace tools are exposed as `external_*`
functions for the current request.

Both Code Mode transports are optional dependencies. The plugin checks the
selected dependency once during startup and uses a Vite-ignored dynamic import,
so bundlers do not turn an unselected transport into a hard dependency.
`codeMode: "auto"` prefers isolated-vm when the runtime supports it, then tries
QuickJS, and leaves Code Mode disabled when neither optional transport can run.
Explicit `"isolated-vm"` or `"quickjs"` selection fails startup when that
transport cannot be loaded or initialized.

Both transports expose no filesystem, network, process, timer, or module access
beyond the explicitly supplied tools. QuickJS supports concurrent external
calls, so generated code can use `Promise.all` for independent operations.

The automatic Code Mode remains available when the workspace uses a Databricks
Lakebox because QuickJS or isolated-vm executes the orchestration program
independently of the workspace command sandbox. SSH is used only if the program
calls an exposed Lakebox-backed tool.

Callers may also use native Mastra `createCodeMode` directly when they want
multiple explicitly scoped orchestration tools, or when the TypeScript program
itself must run in a supplied Sandbox:

```ts
const sales = createCodeMode({
  id: "sales_code",
  tools: { listRecentOrders, getCustomer },
  sandbox,
});
const inventory = createCodeMode({
  id: "inventory_code",
  tools: { listProducts, getSupplier },
  sandbox,
});

const agent = new Agent({
  id: "ops-assistant",
  name: "ops-assistant",
  instructions: ["You are an ops assistant.", sales.instructions, inventory.instructions],
  model: "openai/gpt-5.6-sol",
  tools: { sales_code: sales.tool, inventory_code: inventory.tool },
});
```

This is native Mastra `createCodeMode`. The plugin does not wrap or re-export it.
Configure the plugin with one of these values:

```ts
mastra({ codeMode: false });
mastra({ codeMode: "auto" });
mastra({ codeMode: "isolated-vm" });
mastra({ codeMode: "quickjs" });
mastra({ codeMode: { transport: "quickjs", id: "execute_typescript", timeout: 30_000 } });
```

Install an explicitly selected transport in the consuming application when it
is not already present:

```sh
bun add @mastra/isolated-vm
bun add @mastra/quickjs
```

## Remote skills

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

AI Tools uses the shared `@dbx-tools/cache` project cache and refreshes daily by
default. Other downloaded sources are reused for seven days. Set
`refreshTtlMs` to override either interval or `0` to download on every boot:

```ts
mastra({
  // Re-pull AI Tools at most once an hour instead of once a day.
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
    { source: "owner/repo", name: "team-runbooks" },
  ],
});
```

The source reads the public
[databricks/databricks-agent-skills](https://github.com/databricks/databricks-agent-skills)
repository's generated `manifest.json` and downloads the selected skill files.
It doesn't require the Databricks CLI or Databricks authentication.

Per-source options for `"aitools"`:

- `skills` - install only the named skills instead of the full stable set.
- `experimental` - include the repo's `experimental/` skills (off by default).
- `ref` - pin a tag / branch / sha. Defaults to `main`.

AI Tools is hydrated from the daily cache snapshot into one shared read-only
memory filesystem at `/.databricks/skills`. Other sources also receive a
process-memory copy, including when they persist into a Databricks workspace
destination. These trees are supplied to every agent as standard agent-level
skills rather than workspace-search roots. Local filesystem mounts remain
available below `/.skills` when a Databricks destination is unavailable.

## Genie tools

`genie.buildGenieTools()` and `plugins.genie.toolkit()` expose tools for:

- Asking a configured Genie space.
- Reading space descriptions and serialized space metadata.
- Fetching statement rows by `statement_id`.
- Preparing charts from Genie result sets.

The central agent drives those tools directly. Genie events stream through the
Mastra writer using the shared contract from
[@dbx-tools/shared-mastra](../../shared/mastra), so clients can show thinking,
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
Agent Mode carries query results inline as Markdown and projects the
`statement_id` from each query output onto its query attachment when Databricks
supplies one. Use that id with `get_statement`, `prepare_chart`, or a data
marker. Use `render_data` only when rows are available without a statement id.

```ts
const agent = agents.createAgent({
  instructions: `${baseInstructions}\n\n${genie.GENIE_INSTRUCTIONS}`,
  async tools(plugins) {
    return { ...(await plugins.genie?.toolkit({ prefix: "" })) };
  },
});
```

### Follow-up suggestions

Post-turn suggestions are off by default. Enable one source, or let automatic
mode combine native Genie questions with complementary ChatFast suggestions:

```ts
mastra({
  followUpSuggestions: true,
  agents: { analyst },
});

mastra({
  followUpSuggestions: { mode: "generated", limit: 10 },
  agents: { analyst },
});
```

Accepted shorthand values are `false`, `"genie"`, `"generated"`, and `true`.
`true` resolves to automatic mode and supplies native Genie questions to the
ChatFast generator so it avoids repeats. The default limit is three and the
maximum is ten. Generation runs through Mastra's final output processor and
stream transform outside the primary agent step budget, persists with the
assistant message, and fails open without changing the answer. ChatFast receives
a bounded view of the turn's tool inputs and outputs, so suggestions ask
user-voiced questions about displayed values and results instead of asking the
user for presentation preferences. Set `exposeTool: true` only when the primary
agent should also be able to request suggestions explicitly.

### Direct Genie chat

The plugin also exposes a Genie-only transport for the paired Mastra UI. It
keeps the standard AI SDK `UIMessage` stream and the same tool, thought, table,
and thread presentation without running a Mastra agent:

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

<MastraChat genieSpace="sales" />;
```

The alias must exist in `genieSpaces`. Genie owns the state in this mode:
conversations are thread IDs and Genie messages are projected into the
transcript. No supervisor agent runs. When Mastra memory is configured, direct
turns use the default agent's native memory instance for resource-scoped
semantic recall and save completed question-answer pairs back to it.

Direct Genie chat always uses AppKit's OBO user context, matching the native
AppKit Genie plugin. Service-principal conversations cannot safely back a
multi-user thread list because every viewer would share the same Databricks
conversation owner. Users therefore need workspace access to the configured
space even when agent-backed calls use `genieIdentity: "service-principal"` or
`"auto"`.

Direct turns require the
[Genie Agent API](https://docs.databricks.com/aws/en/genie-agents/api). They
never fall back to the classic start/create/get-message polling flow, and
history comes only from the Agent API conversation-items endpoint. The GA
space conversation-list endpoint is used only to discover conversations marked
`GENIE_CONVERSATION_TYPE_AGENT`. The GA delete endpoints provide the management
operations that the Agent API does not expose.

Agent Mode receives Genie's visualization tool. When Genie emits a
visualization attachment, the answer contains a
`[visualization:<statement_id>]` marker and the client renders the result with
AppKit UI's native Genie Chart/Table component. This path does not use a
supervisor or Model Serving chart planner. Queries Genie does not mark for
visualization remain sortable data tables.

Operational limits:

- The thread list contains the newest 100 Agent Mode conversations.
- Conversation history is Genie-owned and loaded as one UI history page.
- Genie conversations cannot be renamed.
- File attachments, MLflow feedback, approval continuations, background runs,
  and stream reconnection are unavailable.
- Aborting the browser stream cancels that request instead of leaving a durable
  Mastra run to reconnect.

## Charts and data embeds

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
Agent Mode and polling query attachments carry statement ids when Databricks
returns them. Direct Genie chat also uses
`[visualization:<statement_id>]` for AppKit UI's native Genie visualization.

### Chart types and hand-written charts

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

### Brand the charts

Pass a `brand` to the plugin to theme every generated chart with your brand's
palette and font. Omit it for the default Echarts look.

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
[@dbx-tools/ui-mastra](../../ui/mastra)'s chart theming. Brand identity is the
same in either mode. Chrome is not.

## Model selection

`model.buildModel()` adapts the generic resolver from
[@dbx-tools/model](../model) to Mastra, then constructs a request-scoped
Vercel AI SDK ProviderV4 model through
[@dbx-tools/model-protocol](../model-protocol). It resolves the model per
request, so OBO identity and request-specific overrides stay isolated.

Model priority is:

1. Request override (`X-Mastra-Model`, `?model=`, body `model` / `modelId`).
1. Per-agent `model`.
1. Plugin `defaultModel`.
1. `DATABRICKS_SERVING_ENDPOINT_NAME`.
1. Highest-ranked available GPT from the live workspace catalogue,
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

The Chat provider uses a provider-local fetch from
`@dbx-tools/model-protocol`. Mastra does not patch `globalThis.fetch`. The
shared fetch repairs provider-specific wire requirements for both
`fetch(url, { body })` and `fetch(new Request(...))`. In particular,
Databricks-hosted GPT 5.6 Chat Completions with function tools receives
`reasoning_effort: "none"` even when a caller default selected another effort.
Other Chat models receive no synthesized effort, while an explicit supported
caller value is preserved. Responses-only models such as GPT Astra use the
native Responses provider. Claude reasoning replay and Gemini/Claude structured
response content continue through the same shared sanitizer.

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

## Threads, history, and suggestions

When storage is enabled, the plugin provides route helpers and in-process
functions for conversation management:

- `history.loadHistory()` and `history.clearHistory()` read or clear one thread.
- `threads.listThreads()`, `threads.renameThread()`, and
  `threads.deleteThread()` operate on the caller's scoped conversations.
- `genie.collectSpaceSuggestions()` reads starter questions from the configured
  Genie space.

The plugin resolves the active thread from `x-mastra-thread-id`, `?threadId=`,
or a per-session fallback cookie. That keeps streaming, history, and clear
operations aligned around the same conversation id.

## Evaluate in process

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

## Feedback and observability

`observability.buildObservability()` wires Mastra tracing when OTLP export is
configured. `feedbackMode` is the only feedback setting:

- `auto` prefers direct Genie feedback when Genie Agent Mode and a space are
  available, otherwise MLflow when tracing is configured, otherwise none.
- `genie` or `mlflow` selects that destination and fails startup when it is not
  available.
- `none` disables feedback.

`telemetry.attachChatTurnTelemetry()` writes each chat request and response to
the exported root span so MLflow's UC `*_trace_unified` view can display the
turn. It uses AppKit's HTTP server span when present and creates one
request-lifetime fallback span otherwise. Mastra's `mastra.agent_run.*`
attributes remain on a child span.

### Trace fields and tags

- Text-only turns use raw prompt and answer previews.
  `appkit.mastra.chat.messages` and `appkit.mastra.chat.response` retain the
  serialized envelopes.
- `appkit.mastra.identity.mode` records `obo` or `service-principal`.
- `user.id` records the forwarded email or user ID, and `session.id` records the
  Mastra thread ID.
- `mlflow.spanType` is `AGENT` on the root and `GENIE` on `ask_genie`.
- `mlflow.traceTag.agent` records the first model ID for the turn.
  `mlflow.traceTag.genie=true` is added when the turn calls Genie. Later model
  changes do not replace the `agent` tag, and the plugin does not write a
  separate `model` tag.
- `obo_auth=true` and `sp_auth=true` independently record which Databricks
  authentication modes ran. A mixed-auth turn retains both tags.
- `local=true` is added when `environmentUtils.isDatabricksAppEnv()` is false.
- `@dbx-tools/tunnel` adds `tunnel=portr|frp` and
  `tunnel_subdomain=<name>` when the public host matches its tunnel config.
- Other AppKit plugins can call `injectRequestTag()` or `injectRequestTags()`.
  Direct middleware callers can seed `ChatTurnTelemetryOptions.tags`.
  Application code can update active-request tags with
  `recordActiveTraceTag()` or `recordActiveTraceTags()`.

The reserved `mlflow.traceTag.` prefix persists values as trace tags instead of
ordinary span metadata. `appkit.mastra.genie.used` remains a searchable custom
attribute.

```ts
mastra({
  agents: analyst,
  feedbackMode: "auto",
});
```

In Genie Agent Mode, the UI sends Rating and Comment to the originating Genie
message and displays the original Request in the feedback dialog. In MLflow
mode, `mlflow.logFeedback()` logs a human assessment against the active trace.
On Apps UC traces it reads the experiment's
`mlflow.experiment.databricksTraceDestinationPath` tag (or the spans-table tag)
so the assessment URI matches the row the experiment UI shows. The response
header name and request/response schemas live in
[@dbx-tools/shared-mastra](../../shared/mastra).

Outside a Databricks App, an experiment id automatically enables direct MLflow
tracing. The plugin initializes the MLflow Node SDK, injects
`DATABRICKS_CONFIG_PROFILE` into a `databricks://<profile>` tracking URI, and
auto-detects the experiment's UC trace location. `MLFLOW_UC_TRACE_PREFIX` or the
`MLFLOW_UC_CATALOG` / `MLFLOW_UC_SCHEMA` / `MLFLOW_UC_TABLE_PREFIX` trio can
override that location. The local provider forwards only marked chat roots and
their descendants, so unrelated AppKit HTTP, cache, and plugin spans
do not become traces. Before export it also writes the resolved email, user
name, or resource id to MLflow's trace user field. Direct mode requires a
UC-linked experiment. Inside a Databricks App (`environmentUtils.isDatabricksAppEnv()`), this
provider stays off so AppKit remains the single global OTel provider and the
platform telemetry sidecar owns export.

### Export Databricks Apps traces to Unity Catalog

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

```text
[observability] Mastra observability wired through OTel bridge {
  otelBase: 'http://localhost:4314', mlflowAvailable: true, observability: 'mlflow'
}
```

Verify with SQL against the UC `*_trace_unified` view (the REST
`traces/search` API only covers the experiment store, not UC-backed traces).
Schema names with hyphens need backticks. `attributes` is a `VARIANT`, so use
`attributes:['key']::string` rather than `map_keys()`.

## MCP exposure

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

## Drive a turn outside the routes

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
identity. Outside one it resolves to the service principal.
[@dbx-tools/teams](../teams) uses this so a Teams card turn has the same tool
reach - and therefore the same answer - as a chat turn.

## API gate

The stock `@mastra/express` app has broad management routes. The plugin's
default `apiAccess: "scoped"` allows only the chat, read-only metadata,
plugin-owned `/route/*`, embed, model, suggestion, and MCP surfaces that the
client needs. Use `apiAccess: "full"` only for a trusted first-party console.

`server.isMastraRequestAllowed()` is exported for tests and custom dispatch
logic that need the same allowlist.

## Routes

Mounted under the plugin base path, which is `/api/mastra` unless you override
`name`. Product-specific routes use AppKit's `route()` helper. Chat and memory
use Mastra's native route surfaces behind the same scoped request-context gate.

| Method                     | Path                              | Purpose                                                                                                                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET`                      | `/models`                         | Serving-endpoint catalogue for a model picker.                                                                           |
| `GET`                      | `/default-model[/:agentId]`       | Configured default, or highest-ranked live GPT with a general chat fallback, for an unpinned agent. `404` on unknown id. |
| `GET`                      | `/suggestions[/:agentId]`         | Starter questions from the configured Genie spaces. Degrades to `[]`.                                                    |
| `GET`                      | `/embed/chart/:id`                | Long-polls a `[chart:<id>]` marker's cached spec. `?timeoutMs=` up to 5 minutes.                                         |
| `GET`                      | `/embed/data/:id`                 | Rows behind a `[data:<statement_id>]` marker. `?limit=` clamped server-side.                                             |
| `GET`                      | `/embed/visualization/:id`        | OBO-only statement payload for a `[visualization:<statement_id>]` AppKit UI embed.                                       |
| `POST`                     | `/chat/:agentId`                  | Official Mastra AI SDK UI stream, including native `resumeData` continuations.                                           |
| `POST`                     | `/genie/:alias/chat`              | Direct Genie turn projected onto the AI SDK UI stream.                                                                   |
| `GET` / `DELETE`           | `/genie/:alias/threads[...]`      | OBO-only Genie conversation list, history, and deletion.                                                                 |
| `GET`                      | `/genie/:alias/suggestions`       | Starter questions for one direct Genie space.                                                                            |
| `GET` / `PATCH` / `DELETE` | `/memory/threads[...]`            | Native Mastra resource-scoped conversation history and thread management.                                                |
| `POST`                     | `/memory/messages/delete`         | Native message deletion used before regenerating a response.                                                             |
| `GET`                      | `/agents/:agentId/suspended-runs` | Native persisted approval discovery after a reload or restart.                                                           |
| `POST`                     | `/route/feedback`                 | Send feedback to the resolved Genie or MLflow destination. `404` when feedback mode is none.                             |
| `GET`                      | `/route/mlflow-experiment`        | Return the experiment URL only when the active viewer has effective `CAN_MANAGE`. Otherwise, return `{ "url": null }`.   |
| `POST` / `GET`             | `/mcp`, `/sse`, `/messages`       | MCP transports, when `mcp` is enabled.                                                                                   |

The UI consumes `/chat/:agentId` with the AI SDK's `DefaultChatTransport`.

## Environment variables

Every value can also be set through plugin config, which wins. These are the
fallbacks, so a deployment that already follows AppKit's Databricks env naming
needs no extra wiring.

| Variable                                                            | Effect                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABRICKS_SERVING_ENDPOINT_NAME`                                  | Optional model override used when neither the agent nor `defaultModel` names one. Omit for live highest-rank selection.                            |
| `DATABRICKS_GENIE_SPACE_ID`                                         | Genie space registered under the `default` alias.                                                                                                  |
| `MASTRA_GENIE_IDENTITY`                                             | `user` (default, OBO), `service-principal`, or `auto` for the agents' Databricks calls.                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Presence of either turns Mastra tracing on when `observability` is unset. On Apps, the telemetry sidecar injects these.                            |
| `OTEL_PROPAGATORS`                                                  | Set to `none` on Databricks Apps. The plugin disables extraction and injection before serving requests while retaining local async span parenting. |
| `MLFLOW_EXPERIMENT_ID`, `MLFLOW_EXPERIMENT_NAME`                    | Makes MLflow available to automatic or explicit MLflow feedback mode. Assessments read the experiment's UC trace destination tag.                  |
| `MLFLOW_UC_TRACE_PREFIX`                                            | Optional override for the UC table prefix. Omit to use the experiment tag.                                                                         |

## Configuration reference

The main plugin options are:

- `agents` registers a single agent, an array, or a record keyed by stable agent
  ids. Records are best for UIs because the ids become route-visible.
- `defaultAgent` controls which registered agent handles requests that do not
  name an agent explicitly.
- `storage` and `memory` accept `true`, `false`, or concrete Mastra Postgres /
  PgVector options. `true` resolves from `lakebase()` when present.
- `sandbox` defaults to Monty for auto-created workspaces. `false` disables
  command execution. `true` or `"monty"` selects Monty. A native Mastra
  sandbox or resolver supplies another transport.
- `codeMode` exposes all executable tools available to the current request,
  including enabled native workspace tools, through native Mastra Code Mode. It
  defaults on when such tools exist, selecting isolated-vm once at startup and
  falling back to QuickJS only when unavailable. Both transports support
  concurrent external calls without SSH. An SSH connection is needed only when
  an exposed SSH-backed tool is called. Pass `false` to disable it.
- `workspaceSkills` enables Mastra's native on-demand skill search by default.
  Pass `false` to disable it or an object with `topK`, `minScore`, and `ttlMs`
  overrides.
- `workspaceTools` forwards Mastra's native workspace-tool configuration.
  All tools are enabled without approval by default. Global and per-tool
  settings can require approval or disable selected tools.
- `workspaceFallbackToTmp` adds writable, user-scoped `/tmp` storage only when
  no configured Databricks workspace path can be mounted writable.
- `remoteSkills` provisions `SKILL.md` sources from outside the workspace at
  startup (see [Remote Skills](#remote-skills)). Accepts a single source, a
  list, or an options bag with `failOnError`, `userEmail`,
  `databricksBasePath`, and `refreshTtlMs` (one day by default for AI Tools,
  seven days for other sources). A source is `"aitools"` (see
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
- `feedbackMode` is `auto`, `genie`, `mlflow`, or `none`. Explicit unavailable
  destinations fail startup.
- `mcp` controls whether agents are exposed as MCP tools and how that server is
  named.
- `genieIdentity` selects credentials for model discovery, Genie calls, and
  statement fetches. `"user"` uses OBO and requires workspace membership.
  `"service-principal"` lets account-level users call the app without workspace
  membership. `"auto"` uses OBO when the request includes it and otherwise uses
  the service principal. Memory threads, cache namespaces, and trace metadata
  remain user-scoped in all three modes. The environment fallback is
  `MASTRA_GENIE_IDENTITY`. Direct Genie chat routes always require OBO and do
  not use this fallback.
- `apiAccess` chooses the route allowlist. Keep the default scoped mode for
  deployed apps.

Clients that call these routes can import the browser-safe schemas from
[@dbx-tools/shared-mastra](../../shared/mastra).

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
- `genieChat` - direct Genie AI SDK stream, conversation history projection,
  and OBO-only thread operations.
- `chart` / `statement` / `writer` - chart cache, statement row fetches, and
  safe writer events.
- `validation` - request-body validation for the plugin's custom routes.
- `defaults` - cache / retry / timeout settings for the plugin's own outbound
  calls, one constant per call site with its reasoning.
- `style` - `TYPOGRAPHY_RULE`, the one no-emoji / no-em-dash sentence the agent
  style block, the summarizer, and the thread titler all append, so a summary or
  a thread title cannot drift from the prose it sits beside.
- `memory` / `storageSchema` - Lakebase-backed Mastra store/vector setup.
- `montySandbox` - Python-only Pydantic Monty fallback using Node subprocess
  workers.
- `workspaces` / `filesystems` - native Mastra workspace configuration from
  Databricks paths, opt-in user-scoped temp paths, and caller-supplied mounts.
  `filesystems(fs)` wraps any `@dbx-tools/shared-fs` `FileSystem` (including
  `@dbx-tools/databricks` / `@dbx-tools/fs`) as a Mastra mount.
- `remote-skills` - startup provisioning of remote `SKILL.md` sources. The
  `"aitools"` constant reads Databricks' public skill repo through a daily
  `@dbx-tools/cache` snapshot and serves one shared in-memory
  `/.databricks/skills` tree. Other sources go through the optional `skills` CLI
  or a direct fetch. Every source keeps a process-memory standard-skill copy.
  Databricks persistence and read-only local mounts are storage options, not
  runtime search roots. `refreshTtlMs` overrides the source default.
- `mcp` - MCP server construction.
- `observability` / `mlflow` / `telemetry` - tracing, feedback, and stamping chat
  turn I/O onto the HTTP root span for MLflow's UC `*_trace_unified` view.
- `server` / `rest` / `processors` - Express dispatch, Databricks REST helpers,
  and stale chart-id input cleanup.

Browser-facing wire types are in
[@dbx-tools/shared-mastra](../../shared/mastra). Genie event contracts are in
[@dbx-tools/shared-genie](../../shared/genie). Model request/result contracts
are in [@dbx-tools/shared-model](../../shared/model). The matching React chat
surface is [@dbx-tools/ui-mastra](../../ui/mastra).
