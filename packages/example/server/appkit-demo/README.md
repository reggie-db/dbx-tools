# @dbx-tools/demo-appkit-server

The AppKit server half of the demo Databricks App. One `createApp` call mounts
the plugins, and one shared definition factory creates the Agent Mode and polling
analyst agents. Supporting modules
handle the topic bus, static delivery, deployment staging, and shared types.

## Quick Start

The demo server is one AppKit plugin list:

```ts
await appkit.createApp({
  plugins: [
    server({ host, staticPath: clientDist }),
    genie(),
    lakebase(),
    memory(),
    email(),
    teams(),
    mastra({ agents: { support, "support-polling": supportPolling } }),
  ],
});
```

## What it wires

- `appkit.createApp` from [`@dbx-tools/appkit`](../../../js/node/appkit) —
  the auto-configuring wrapper that resolves Lakebase/Postgres env before the
  plugins run, then delegates to AppKit's `createApp`.
- `mastra(...)` from
  [`@dbx-tools/appkit-mastra`](../../../js/node/appkit-mastra) — the
  Mastra agent as an AppKit plugin: automatic OBO/front-door and
  service-principal/tunnel auth,
  Lakebase-backed storage/memory, workspace file/skill/sandbox capabilities,
  model selection, history, threads, scoped routes, and lazy Databricks Lakebox
  command execution with Python-only Monty fallback. The demo agent also validates typed route/entity
  request context and exposes `get_ui_context` to prove tools receive it.
- `genie()` + `buildGenieTools()` - the default `support` agent uses Genie Agent
  Mode SSE, while `support-polling` forces Conversation API polling for
  statement-backed comparison. Both drive the same space through `ask_genie`;
  Agent Mode charts inline rows with `render_data`, while polling can use
  `get_statement` and `prepare_chart`. The space binding grants `CAN_EDIT`
  because Databricks gates the serialized-space API behind it; the suggestions
  route reads the current `config.sample_questions` dynamically and the app
  hard-codes none of their text.
- The Mastra plugin's direct `/genie/:alias/*` routes back the client's
  `/genie` page. They use the native AppKit Genie space binding and mandatory
  OBO identity, project Agent Mode events onto AI SDK UI messages, and keep
  conversations and messages in Genie rather than Mastra Memory.
- `email()` + `emailTool()` from
  [`@dbx-tools/email`](../../../js/node/email) — an approval-gated
  `send_email` tool: the model can call it, but the send suspends until the user
  approves it in the chat UI.
- `lakebase()` (AppKit) — backs Mastra Memory.
- `memory()` from
  [`@dbx-tools/appkit-memory`](../../../js/node/appkit-memory) contributes
  `remember` and `recall_memory`. It checks Databricks Agent Memory first and
  lazy-starts the Graphiti fallback only for callers without managed-memory
  access. Mastra keeps PostgresStore and PgVector as its standard memory.
  `DBX_TOOLS_MEMORY_SAVE_TURNS=true` also mirrors completed turns to Graphiti
  while the managed store is unavailable.
- `busDemo()` from `src/bus-demo.ts` — a `PostgresTopicBus` from
  [`@dbx-tools/postgres`](../../../js/node/postgres) on the Lakebase pool:
  `POST /api/bus-demo/messages` broadcasts, `GET /api/bus-demo/events` streams to
  every viewer. Backs the client's Bus page.

## Files

- `src/server.ts` - the plugin list plus the shared definition factory for the
  Agent Mode and polling agents. `mastra({ genieAgentMode: true })` makes Agent
  Mode explicit for the default `support` route.
- `src/launch.ts` — an optional child-process wrapper that strips emojis from logs.
- `src/bus-demo.ts` — the topic-bus plugin behind the Bus page.
- `app.yaml` — the Node runtime command used by bundle and click-to-deploy launches.
- `databricks.yml` — Asset Bundle: the Lakebase autoscaling Postgres project,
  the app resource, and the deployed environment/resource overrides.
- `stage-deploy.ts` — stages a self-contained deploy tree (see Deploy).
- `appkit.plugins.json` — the AppKit v2 native template-plugin catalogue;
  Graphiti and the dbx-tools add-ons are registered directly in `server.ts`.

Refresh and validate the catalogue from the trusted installed AppKit package:

```bash
bunx @databricks/appkit plugin sync --write --allow-js-manifest \
  --plugins-dir ../../../../node_modules/@databricks/appkit/dist/plugins \
  --package-name @databricks/appkit \
  --require-plugins server,genie,lakebase
bunx @databricks/appkit plugin validate appkit.plugins.json
```

## Run

```bash
bun install
uv sync --all-packages
bun run demo
```

From the repository root, this builds the client once, then starts AppKit at
`http://localhost:8000`. A started Graphiti fallback and the managed model
gateway use separate loopback ports. The demo runner reads the endpoint from this package's bundle defaults and uses
`@dbx-tools/appkit` auto-configuration once before passing the resolved
Lakebase environment to every child. See the repository root README and
`AGENTS.md` for workspace setup and environment behavior.

For focused assistant UI work, optional integrations can be skipped and email
can use the local file outbox:

```bash
GRAPHITI_ENABLED=0 BUS_ENABLED=0 REMOTE_SKILLS_ENABLED=0 \
SMTP_HOST= SMTP_USER= SMTP_PASSWORD= EMAIL_OUTBOX_MODE=1 bun run demo
```

The feature flags default to enabled, so normal demo and deployment behavior is
unchanged.

On shutdown, AppKit invokes each plugin's bounded `shutdown()` hook. The memory
plugin stops Graphiti when the fallback sidecar was started, which closes the
PostGraph client pool before the process deadline.

## Deploy

This package's `@dbx-tools/*` deps are `workspace:*` and its third-party deps are
`catalog:`, neither of which resolves when the Databricks Apps platform installs
the uploaded source. Staging discovers the demo's transitive runtime workspace
dependencies, packs their locally compiled publish artifacts into local npm
archives, and builds the Python workspace wheels locally. External Node
dependencies remain ordinary registry dependencies installed by the Apps build;
the deploy never uploads `node_modules`.

From the repository root, `bun run demo:deploy` compiles the workspace, stages
the tree, resolves default environment or configured credentials through
`@dbx-tools/auth`, force-refreshes its token with interactive login fallback,
and passes the resolved profile to bundle validate/deploy/`demo_app` when auth
selected one. Pass `--demo-deploy` on `bun run release` to do the same after
tagging (off by default).

```bash
bun run demo:deploy
```

The same steps by hand:

```bash
bun run --filter '@dbx-tools/demo-appkit-app' compile   # client build the server serves
bun run compile                                        # current local package artifacts
bun stage-deploy.ts                                     # reads the root VERSION
cd "$(dirname "$(mktemp -u)")/dbx-tools-deploy-app"     # printed by stage-deploy
databricks bundle validate -t <target> --profile <resolved-profile>
databricks bundle deploy -t <target> --profile <resolved-profile>
databricks bundle run demo_app -t <target> --profile <resolved-profile>
```

The staged app includes both `package.json` and `requirements.txt`. Databricks
Apps installs the Node server from staged local `file:` archives and installs
the locally built Graphiti and Node-runtime wheels. In Databricks Apps, the
memory plugin selects the newest `python` or `python3` interpreter that can
import the installed wheel. The Graphiti wheel includes its pinned generated
REST, MCP, and PostGraph sources; Node only supervises its process. npm and PyPI
publication do not need to finish before the demo deploy uses the current
checkout.

Two things worth knowing before changing this flow:

- **Stage outside the repo.** `stage-deploy.ts` writes to the OS temp dir on
  purpose. The bundle CLI filters its upload through the repository checkout's
  `.gitignore`, and this repo ignores every `dist` directory. If staging happens there,
  `bundle deploy` warns "There are no files to sync" and ships an app with no
  source.
- **Keep auth resolution centralized.** `scripts/demo-deploy.ts` calls
  `createAuthClient()` without parallel environment parsing, so
  `DATABRICKS_CONFIG_PROFILE`, `DATABRICKS_HOST`, and the other auth options
  follow `@dbx-tools/auth` precedence. When auth selects a profile, the script
  passes it explicitly to every workspace call. The bundle does not duplicate
  the workspace host.
- **The deployed server runs under Node.** `app.yaml` launches `src/server.ts`
  through Node's `--import tsx` support. The staging tree includes the source and
  installs `tsx` as a normal runtime dependency. Local development, compilation,
  staging, and the client build remain Bun-first. Keeping the command in
  `app.yaml` also gives click-to-deploy the same runtime as the bundle.
- **To bounce the app, use `bundle run demo_app`.** It restarts a running app in
  place with the bundle's environment and resource bindings. A lost portr edge
  (`demo.apps.dbx.tools` serving `unregistered-subdomain` while the platform
  URL still answers) is also recovered automatically by `@dbx-tools/tunnel`:
  the supervisor probes the public URL and restarts portr when the subdomain
  drops. A bounce is still the fastest manual recovery if you need the tunnel
  back immediately.

If the app already exists in the workspace but not in this bundle's state,
`deploy` fails with `ALREADY_EXISTS`; adopt it once with
`databricks bundle deployment bind demo_app dbx-tools-demo`.
