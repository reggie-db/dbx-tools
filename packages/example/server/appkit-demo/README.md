# @dbx-tools/demo-appkit-server

The AppKit server half of the demo Databricks App. One `createApp` call mounts
the plugins, and one `createAgent` defines the analyst agent. Supporting modules
handle the topic bus, static delivery, deployment staging, and shared types.

## What it wires

- `appkit.createApp` from [`@dbx-tools/appkit`](../../../js/node/appkit) —
  the auto-configuring wrapper that resolves Lakebase/Postgres env before the
  plugins run, then delegates to AppKit's `createApp`.
- `mastra(...)` from
  [`@dbx-tools/appkit-mastra`](../../../js/node/appkit-mastra) — the
  Mastra agent as an AppKit plugin: OBO auth, Lakebase-backed storage/memory,
  workspace skills, model selection, history, threads, and scoped routes.
- `genie()` + `plugins.genie?.toolkit()` — the agent drives the Genie space
  (`ask_genie`, `get_statement`, `prepare_chart`, …) for SQL-backed answers with
  streaming progress and inline charts.
- `email()` + `emailTool()` from
  [`@dbx-tools/email`](../../../js/node/email) — an approval-gated
  `send_email` tool: the model can call it, but the send suspends until the user
  approves it in the chat UI.
- `lakebase()` (AppKit) — backs Mastra Memory.
- `graphiti()` from
  [`@dbx-tools/appkit-graphiti`](../../../js/node/appkit-graphiti) — launches
  the Python Graphiti MCP sidecar, journals its graph writes to the same
  Lakebase binding, and mounts its Caddy-backed MCP transport at
  `/api/graphiti/mcp` on the AppKit server. Graphiti groups use the same
  per-user resource id as Mastra memory.
- `busDemo()` from `src/bus-demo.ts` — a `PostgresTopicBus` from
  [`@dbx-tools/postgres`](../../../js/node/postgres) on the Lakebase pool:
  `POST /api/bus-demo/messages` broadcasts, `GET /api/bus-demo/events` streams to
  every viewer. Backs the client's Bus page.

## Files

- `src/server.ts` — the plugin list and agent definition.
- `src/launch.ts` — the deployed process wrapper that strips emojis from logs.
- `src/bus-demo.ts` — the topic-bus plugin behind the Bus page.
- `app.yaml` — Databricks App runtime env wiring (`genie-space`, `postgres`).
- `databricks.yml` — Asset Bundle: the Lakebase autoscaling Postgres project,
  the app resource, and the deployed `command`/`env` overrides.
- `stage-deploy.ts` — stages a self-contained deploy tree (see Deploy).
- `appkit.plugins.json` — native AppKit template plugins synchronized by
  `appkit plugin sync`; Graphiti is registered directly in `server.ts`.

## Run

```bash
bun install
uv sync --all-packages
bun run demo
```

From the repository root, this builds the client once, then starts AppKit at
`http://localhost:8000`. Graphiti, managed LiteLLM, and Caddy use separate
loopback ports. A local uv Python emitter publishes `Hello world` onto the Bus
page every random 5 to 10 seconds. The
demo runner reads the endpoint from this package's bundle defaults and uses
`@dbx-tools/appkit` auto-configuration once before passing the resolved
Lakebase environment to every child. The emitter is not included in the
Databricks App deployment. See the repository root README and `AGENTS.md` for
workspace setup and environment behavior.

On shutdown, AppKit closes the per-user MCP servers and internal client.
`concurrently` terminates Graphiti and Caddy, Honcho forwards termination to
Graphiti and managed LiteLLM, and both supervisors escalate unresponsive
children after their bounded grace periods. The Python launcher stops Neo4j
when Honcho exits.

## Deploy

This package's `@dbx-tools/*` deps are `workspace:*` and its third-party deps are
`catalog:`, neither of which resolves when the Databricks Apps platform installs
the uploaded source. Both example manifests link their version to the root
workspace release, and staging converts `@dbx-tools/*` to that published version:

```bash
bun run --filter '@dbx-tools/demo-appkit-app' compile   # client build the server serves
bun stage-deploy.ts                                     # reads the linked example version
cd "$(dirname "$(mktemp -u)")/dbx-tools-deploy-app"     # printed by stage-deploy
databricks bundle validate --profile FEVM-REGGIE-PIERCE-AWS
databricks bundle deploy --profile FEVM-REGGIE-PIERCE-AWS
databricks bundle run demo_app --profile FEVM-REGGIE-PIERCE-AWS
```

The staged app includes both `package.json` and `requirements.txt`. Databricks
Apps installs the Node server and matching `dbx-tools-graphiti` Python release;
the Graphiti plugin installs Caddy through mise on first start.
Staging replaces workspace dependencies with `^<workspace-version>` and writes
`dbx-tools-graphiti==<workspace-version>`. Uncommitted package changes are not
included unless that version has been published.

Two things worth knowing before changing this flow:

- **Stage outside the repo.** `stage-deploy.ts` writes to the OS temp dir on
  purpose. The bundle CLI filters its upload through the enclosing worktree's
  `.gitignore`, and this repo ignores every `dist` directory — staged there,
  `bundle deploy` warns "There are no files to sync" and ships an app with no
  source.
- **Pass the FEVM profile explicitly.** `DATABRICKS_CONFIG_PROFILE` overrides
  the profile declared by the bundle target. Without `--profile
FEVM-REGGIE-PIERCE-AWS`, a shell configured for the deployment service
  principal creates a separate bundle state and then fails because the app and
  Lakebase project are already managed by the human-owned FEVM bundle.
- **Start with `bundle run`, not `databricks apps deploy` or `apps start`.** The
  deployed `command` (`bun src/launch.ts`, which normalizes child output and
  starts the server that fronts itself with the public portr tunnel + OTP gate
  in-process via `@dbx-tools/tunnel`'s `tunnelInterceptor`)
  lives in `databricks.yml` under the app resource's `config`, which only the
  bundle applies. A bare `apps deploy` falls back to `app.yaml`'s `npm run start`,
  which the staged tree has no script for, and the app crashes on boot. `databricks
apps stop` + `apps start` is the same trap: `start` re-deploys the last source
  snapshot with the app.yaml command, so it takes a RUNNING app to
  `FAILED`/`Missing script: "start"`. Recover with `bundle deploy` +
  `bundle run demo_app`.
- **To bounce the app, use `bundle run demo_app`.** It restarts a running app in
  place with the bundle's command, which is what brings the public portr tunnel
  back when its edge has dropped (`demo.apps.dbx.tools` serving portr's
  "Connection Lost" while the platform URL still answers) — the tunnel child is
  supervised but not re-dialed, so a lost portr session outlives the app process
  that started it.

If the app already exists in the workspace but not in this bundle's state,
`deploy` fails with `ALREADY_EXISTS`; adopt it once with
`databricks bundle deployment bind demo_app dbx-tools-demo`.
