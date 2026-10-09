# @dbx-tools/demo-appkit-server

The AppKit server half of the demo Databricks App. One `createApp` call mounts
the plugins, and one shared definition factory creates the Agent Mode and polling
analyst agents. Supporting modules
handle the topic bus, static delivery, deployment staging, and shared types.

## What it wires

- `appkit.createApp` from [`@dbx-tools/appkit`](../../../js/node/appkit) —
  the auto-configuring wrapper that resolves Lakebase/Postgres env before the
  plugins run, then delegates to AppKit's `createApp`.
- `mastra(...)` from
  [`@dbx-tools/appkit-mastra`](../../../js/node/appkit-mastra) — the
  Mastra agent as an AppKit plugin: automatic OBO/front-door and
  service-principal/tunnel auth,
  Lakebase-backed storage/memory, workspace skills, model selection, history,
  threads, scoped routes, and lazy Databricks Sandbox command execution with
  Python-only Monty fallback. The demo agent also validates typed route/entity
  request context and exposes `get_ui_context` to prove tools receive it.
- `genie()` + `buildGenieTools()` - the default `support` agent uses Genie Agent
  Mode SSE, while `support-polling` forces Conversation API polling for
  statement-backed comparison. Both drive the same space through `ask_genie`;
  Agent Mode charts inline rows with `render_data`, while polling can use
  `get_statement` and `prepare_chart`. The space binding grants `CAN_EDIT`
  because Databricks gates the serialized-space API behind it; the suggestions
  route reads the current `config.sample_questions` dynamically and the app
  hard-codes none of their text.
- `email()` + `emailTool()` from
  [`@dbx-tools/email`](../../../js/node/email) — an approval-gated
  `send_email` tool: the model can call it, but the send suspends until the user
  approves it in the chat UI.
- `lakebase()` (AppKit) — backs Mastra Memory.
- `graphiti()` from
  [`@dbx-tools/appkit-graphiti`](../../../js/node/appkit-graphiti) — launches
  the unified Python Graphiti runtime and contributes its OpenAPI-derived,
  user-scoped memory tools directly to the agents. Graphiti groups use the same
  per-user resource id as Mastra memory.
- `busDemo()` from `src/bus-demo.ts` — a `PostgresTopicBus` from
  [`@dbx-tools/postgres`](../../../js/node/postgres) on the Lakebase pool:
  `POST /api/bus-demo/messages` broadcasts, `GET /api/bus-demo/events` streams to
  every viewer. Backs the client's Bus page.

## Files

- `src/server.ts` - the plugin list plus the shared definition factory for the
  Agent Mode and polling agents. `mastra({ genieAgentMode: true })` makes Agent
  Mode explicit for the default `support` route.
- `src/launch.ts` — the deployed process wrapper that strips emojis from logs.
- `src/bus-demo.ts` — the topic-bus plugin behind the Bus page.
- `app.yaml` — Databricks App runtime env wiring (`genie-space`, `postgres`).
- `databricks.yml` — Asset Bundle: the Lakebase autoscaling Postgres project,
  the app resource, and the deployed `command`/`env` overrides.
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
`http://localhost:8000`. Graphiti and the managed model gateway use separate
loopback ports. The demo runner reads the endpoint from this package's bundle defaults and uses
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

On shutdown, AppKit invokes each plugin's bounded `shutdown()` hook. The
Graphiti plugin stops its supervised Python runtime, which closes the PostGraph
client pool before the process deadline.

## Deploy

This package's `@dbx-tools/*` deps are `workspace:*` and its third-party deps are
`catalog:`, neither of which resolves when the Databricks Apps platform installs
the uploaded source. Staging discovers the demo's transitive runtime workspace
dependencies, packs their locally compiled publish artifacts into local npm
archives, and builds the Python workspace wheels locally. External Node
dependencies remain ordinary registry dependencies installed by the Apps build;
the deploy never uploads `node_modules`.

From the repository root, `bun run demo:deploy` compiles the workspace, stages
the tree, resolves the configured/default workspace profile through
`@dbx-tools/auth`, and passes that profile explicitly to bundle
validate/deploy/`demo_app`. Pass `--demo-deploy` on `bun run release` to do the
same after tagging (off by default).

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
the locally built Graphiti and Node-runtime wheels. The bundle sets
`PYTHON=./.venv/bin/python` so the Graphiti plugin uses that Python 3.11
environment. The Graphiti wheel includes its pinned generated REST, MCP, and
PostGraph sources; Node only supervises its process. npm and PyPI publication do
not need to finish before the demo deploy uses the current checkout.

Two things worth knowing before changing this flow:

- **Stage outside the repo.** `stage-deploy.ts` writes to the OS temp dir on
  purpose. The bundle CLI filters its upload through the repository checkout's
  `.gitignore`, and this repo ignores every `dist` directory. If staging happens there,
  `bundle deploy` warns "There are no files to sync" and ships an app with no
  source.
- **Pass the detected profile explicitly.** `DATABRICKS_CONFIG_PROFILE` can
  otherwise retarget bundle commands. `scripts/demo-deploy.ts` resolves the
  configured/default local profile through `@dbx-tools/auth` and passes both
  target and profile to every workspace call. The profile owns the workspace
  host; the bundle does not duplicate it.
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
  place with the bundle's command. Prefer this over `databricks apps stop` +
  `apps start`: `start` re-deploys the last source snapshot with the app.yaml
  command, so it can take a RUNNING app to `FAILED`/`Missing script: "start"`.
  Recover with `bundle deploy` + `bundle run demo_app`. A lost portr edge
  (`demo.apps.dbx.tools` serving `unregistered-subdomain` while the platform
  URL still answers) is also recovered automatically by `@dbx-tools/tunnel`:
  the supervisor probes the public URL and restarts portr when the subdomain
  drops. A bounce is still the fastest manual recovery if you need the tunnel
  back immediately.

If the app already exists in the workspace but not in this bundle's state,
`deploy` fails with `ALREADY_EXISTS`; adopt it once with
`databricks bundle deployment bind demo_app dbx-tools-demo`.
