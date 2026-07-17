# @dbx-tools/demo-appkit-server

The AppKit server half of the demo Databricks App. One `createApp` call mounts
the plugins; one `createAgent` defines the analyst agent. That's the whole
backend.

## What it wires

- `createApp` from [`@dbx-tools/node-appkit`](../../../workspaces/node/appkit) —
  the auto-configuring wrapper that resolves Lakebase/Postgres env before the
  plugins run, then delegates to AppKit's `createApp`.
- `mastra(...)` from
  [`@dbx-tools/node-appkit-mastra`](../../../workspaces/node/appkit-mastra) — the
  Mastra agent as an AppKit plugin: OBO auth, Lakebase-backed storage/memory,
  workspace skills, model selection, history, threads, and scoped routes.
- `genie()` + `plugins.genie?.toolkit()` — the agent drives the Genie space
  (`ask_genie`, `get_statement`, `prepare_chart`, …) for SQL-backed answers with
  streaming progress and inline charts.
- `email()` + `emailTool()` from
  [`@dbx-tools/node-email`](../../../workspaces/node/email) — an approval-gated
  `send_email` tool: the model can call it, but the send suspends until the user
  approves it in the chat UI.
- `lakebase()` (AppKit) — backs Mastra Memory.

## Files

- `src/server.ts` — the plugin list + agent definition (the only code here).
- `app.yaml` — Databricks App runtime env wiring (`genie-space`, `postgres`).
- `databricks.yml` — Asset Bundle: the Lakebase autoscaling Postgres project.
- `appkit.plugins.json` — AppKit plugin manifest (`appkit plugin sync`).

## Run

```bash
pnpm dev     # tsx watch over src/server.ts
```

Serves the sibling [`@dbx-tools/demo-appkit-app`](../../app/appkit-demo) build
(`../../app/appkit-demo/dist`) on the same port as the API. See the
[demo README](../../README.md) for full setup and env.
