# dbx-tools demo — a Databricks App in a few lines

A runnable Databricks App that stands up a **streaming Genie chat agent** — with
tool-calling, approval-gated email, conversation memory, a model picker, history,
and threads — on top of the `@dbx-tools/*` packages.

The point of this folder is to show **how little you write**. It is a real,
standalone downstream consumer: its own project, its own pnpm workspace, pulling
`@dbx-tools/*` from a registry exactly like any external app would. Two small
packages:

| Package                                    | Tag      | What you write                               |
| ------------------------------------------ | -------- | -------------------------------------------- |
| [`server/appkit-demo`](server/appkit-demo) | `server` | ~30 lines: an AppKit `createApp` plugin list |
| [`app/appkit-demo`](app/appkit-demo)       | `app`    | one line: `<MastraChat/>`                    |

Everything else — streaming, the Genie toolset, the approval card, Lakebase-backed
memory, model selection, history pagination, and the thread switcher — comes from
the packages. The demo is wiring, not implementation.

## The whole server

```ts
// server/appkit-demo/src/server.ts (abridged)
await createApp({
  plugins: [
    server({ host, staticPath: clientDist }),
    genie(),
    lakebase(),
    email(), // approval-gated send_email tool transport
    teams(), // create_teams_card tool + /api/teams/card route
    mastra({ storage: true, memory: true, agents: support }),
  ],
  cache: { enabled: true },
});
```

The agent is one `createAgent({...})` that spreads the Genie toolkit
(`...plugins.genie?.toolkit()`) and adds `send_email: emailTool()` and
`create_teams_card: teamsCardTool()`.

## The whole client page

```tsx
// app/appkit-demo/src/pages/Stream.tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

const Stream = () => <MastraChat showModelPicker enableExport />;
export default Stream;
```

`MastraChat` wires itself from the Mastra plugin's published client config — no
transport code, no streaming plumbing.

The **Cards** page (`app/appkit-demo/src/pages/Cards.tsx`) has two tabs over the
`teams()` plugin. **Chat** is a Teams conversation: `<TeamsChat/>` posts a Bot
Framework activity to `/api/teams/messages` — the same endpoint a real Teams
channel calls — and the Mastra agent answers with Adaptive Card attachments,
which render like a Teams channel. **Card builder** is the lower-level view: edit a `CardSpec` (or
pick a sample), compile it through `/api/teams/card`, and see the document
render. Both use the `adaptivecards` JavaScript renderer — the same one Teams
preview tools embed.

The Cards page answers with the SAME content the Stream page does - ask both
"what were inside sales PSPW and gross margin this week?" and both call Genie and
report the same numbers. That is the point of the endpoint: the agent, its tools,
and its data are identical, and only the presentation changes (a card instead of
streamed markdown). Its starter prompts come from the same place too: the page
reads the agent's Genie sample questions off the Mastra plugin's `/suggestions`
route (`useMastraSuggestions` + `dedupeSuggestions`, exactly what `MastraChat`
does), so neither page offers a prompt the agent cannot answer. See
[`@dbx-tools/teams`](../packages/node/teams/README.md) for the two-pass turn
that makes it so.

The demo registers the plugin as `teams({ allowUnauthenticated: true })`, which
serves `/messages` with no Bot Service token validation and replies in the HTTP
response, so the page works with no Azure Bot registration. That option is
ignored unless `NODE_ENV=development` (which the local dev server sets). A real
deployment sets `TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` instead and gets the
JWT-validated, Connector-delivered path — see
[`@dbx-tools/teams`](../packages/node/teams/README.md).

```tsx
// app/appkit-demo/src/pages/Cards.tsx
import { AdaptiveCardGallery, TeamsChat } from "@dbx-tools/ui-teams/react";

const Cards = () => <TeamsChat className="h-full" />;
export default Cards;
```

Because the endpoint speaks the real Bot Framework envelope, the same route the
chat uses can be driven with `curl` — a bare activity, exactly what Bot Service
posts:

```bash
curl -X POST http://localhost:6868/api/teams/messages \
  -H 'content-type: application/json' \
  -d '{"type":"message","text":"summarize today",
       "from":{"id":"user-1"},"conversation":{"id":"conv-1"}}'
```

## Setup

This demo consumes `@dbx-tools/*` from the registry set in [`.npmrc`](.npmrc).

1. **Make the packages available.** For local development, publish them to a local
   registry (verdaccio) and point `.npmrc` at it (already the default):

   ```bash
   # from the main repo root, publish the packages to your local registry:
   pnpm -r --filter "./packages/**" publish \
     --registry http://localhost:4873 --no-git-checks
   ```

   Once the packages are on public npm, delete the `@dbx-tools:registry` line in
   `.npmrc` (or point it at `https://registry.npmjs.org/`).

2. **Install + configure:**

   ```bash
   pnpm install                       # from this demo/ folder
   cp .env.example .env               # fill in the Databricks values (see below)
   databricks auth login --host "$DATABRICKS_HOST"
   ```

3. **Run** (client + server, two processes):

   ```bash
   pnpm --filter @dbx-tools/demo-appkit-app dev      # vite dev server
   pnpm --filter @dbx-tools/demo-appkit-server dev   # tsx watch on the API
   ```

   The server serves the client's built `dist/` on the same port as the API.

   Run the server with `NODE_ENV=development` locally. Outside a Databricks App
   nothing sets the `x-forwarded-access-token` header, and AppKit's `asUser(req)`
   only falls back to the service principal in development mode - otherwise the
   first user-scoped route (e.g. `GET /api/mastra/models`, which the chat UI
   calls on load) throws `AuthenticationError` from inside the handler and takes
   the process down.

## Two dev modes

Which mode you want depends on whether you're building a CONSUMING project or
working on the `@dbx-tools/*` packages themselves.

### Consumer mode (default) — for consuming projects

`@dbx-tools/*` install as normal versioned packages from the registry in
[`.npmrc`](.npmrc). This is exactly how a downstream app consumes them, so it's
the right mode when the demo (or your own app) is the thing under development and
the packages are a fixed dependency. To pick up a new package version you
bump/publish it, then `pnpm update "@dbx-tools/*" --latest` and rebuild.

### Dev-link mode — for iterating on the CLIENT UI packages in THIS repo

When you're editing the UI package source in `../packages/ui/**`, the
bump → publish → update → rebuild loop is too slow. `dev-link` adds the
client-reachable packages (`ui-*` + the browser-safe `shared-*` they
pull) as pnpm workspace members and points the client app's `@dbx-tools/*` deps
at that source, so a `vite build --watch` rebuilds the bundle on every edit:

```bash
node scripts/dev-link.mjs                                  # link client UI source
pnpm --filter @dbx-tools/demo-appkit-server dev            # server (unchanged, serves dist/)
pnpm --filter @dbx-tools/demo-appkit-app exec vite build --watch  # rebuild dist/ on UI source edits
# edit anything under ../packages/ui/**/src, refresh the browser — no republish.

node scripts/dev-link.mjs --unlink                         # restore the registry consumer mode
```

`dev-link` discovers the linked set automatically — the closure of the client
app's `@dbx-tools/*` deps followed through each package's own deps — so it needs
no maintenance as packages are added or renamed. It edits only transient,
gitignored files (`pnpm-workspace.yaml`, the app manifest, a `.dev-link.json`
sidecar); run `--unlink` (or discard the changes) before committing.

**Client only, on purpose.** The SERVER packages are NOT linked: their
transitive `@databricks/appkit` / `@mastra/*` would resolve to a second
physical install (same version, different peer-hash) than the demo's, so
singletons like AppKit's `CacheManager` initialize in one copy and are read
from the other. The browser build sidesteps this via vite's React `dedupe`,
which has no server-side (tsx) equivalent. So server changes still go through
bump → publish → `pnpm update` → restart; only the UI packages source-link.

## Required env

See [`.env.example`](.env.example). At minimum:

- `DATABRICKS_HOST`, `DATABRICKS_SERVING_ENDPOINT_NAME`, `DATABRICKS_GENIE_SPACE_ID`
- `LAKEBASE_*` / `PG*` for memory-backing Postgres
- SMTP (or `EMAIL_OUTBOX_MODE=1`) for the `send_email` tool

## Demo KPI dataset and Genie space

The agent's Genie tools need a space with data behind them. A ready-made KPI
dataset is provisioned in the FEVM workspace
(`fevm-reggie-pierce-aws.cloud.databricks.com`):

| Resource                                                    | What it is                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `reggie_pierce_aws_catalog.dbx_tools_demo.fact_usage_daily` | Daily consumption fact (~42k rows), customer x product x day, 2024-01-01 to 2025-12-31 |
| `…dbx_tools_demo.dim_customer`                              | 120 accounts with segment, industry, region, acquisition channel                       |
| `…dbx_tools_demo.dim_product`                               | 8 SKUs across the Compute / AI / Storage families, with list price and unit cost       |
| `…dbx_tools_demo.dim_date`                                  | Daily calendar spine with year, quarter, `year_month`, weekend flag                    |
| `…dbx_tools_demo.vw_monthly_kpis`                           | Monthly rollup with margin %, revenue per customer, and month-over-month growth %      |

The figures are generated deterministically from the natural keys, so the shape
is stable across rebuilds: steady growth through the window, a Q4 seasonal lift,
lighter weekend usage, and margins that differ by product family — enough for
trend, mix, cohort, and margin questions to all return something interesting.

Genie space **`dbx-tools Demo KPIs`** (`01f18902a1781636a3a4f383de2147e0`) is
wired to those tables with column descriptions, 12 sample questions, analyst
instructions, and 8 example question/SQL pairs. Point the demo at it with:

```bash
DATABRICKS_GENIE_SPACE_ID=01f18902a1781636a3a4f383de2147e0
```

## SMTP secrets

The deployed app reads SMTP config from the `dbx-tools-demo` Databricks secret
scope rather than from `.env`, so no credential is committed:

```bash
databricks secrets list-secrets dbx-tools-demo
# email-domain, email-from, smtp-host, smtp-password, smtp-port, smtp-secure, smtp-user
```

[`app.yaml`](server/appkit-demo/app.yaml) maps each one to the matching env var
via `valueFrom`. Grant the app's service principal `READ` on the scope
(`databricks secrets put-acl dbx-tools-demo <sp-id> READ`) before deploying.

## Deploy

```bash
cd server/appkit-demo
databricks bundle validate
databricks bundle deploy
```

The bundle ([`databricks.yml`](server/appkit-demo/databricks.yml)) provisions the
Lakebase autoscaling Postgres; [`app.yaml`](server/appkit-demo/app.yaml) wires the
Genie space and Lakebase endpoint into the deployed app.

## How the demo itself is configured

`demo/.projenrc.ts` is the entire build/workspace config — a standalone projen
root that discovers the two packages and applies their dependencies. It's
deliberately tiny; the `server`/`app` tags supply the tsx/vite toolchain.
