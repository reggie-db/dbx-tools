# dbx-tools demo — a Databricks App in a few lines

A runnable Databricks App that stands up a **streaming Genie chat agent** — with
tool-calling, approval-gated email, conversation memory, a model picker, history,
and threads — on top of the `@dbx-tools/*` packages.

The point of this folder is to show **how little you write**. It is a real,
standalone downstream consumer: its own project, its own pnpm workspace, pulling
`@dbx-tools/*` from a registry exactly like any external app would. Two small
packages:

| Package | Tag | What you write |
| --- | --- | --- |
| [`server/appkit-demo`](server/appkit-demo) | `server` | ~30 lines: an AppKit `createApp` plugin list |
| [`app/appkit-demo`](app/appkit-demo) | `app` | one line: `<MastraChat/>` |

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
    email(),                       // approval-gated send_email tool transport
    mastra({ storage: true, memory: true, agents: support }),
  ],
  cache: { enabled: true },
});
```

The agent is one `createAgent({...})` that spreads the Genie toolkit
(`...plugins.genie?.toolkit()`) and adds `send_email: emailTool()`.

## The whole client page

```tsx
// app/appkit-demo/src/pages/Stream.tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

const Stream = () => <MastraChat showModelPicker enableExport />;
export default Stream;
```

`MastraChat` wires itself from the Mastra plugin's published client config — no
transport code, no streaming plumbing.

## Setup

This demo consumes `@dbx-tools/*` from the registry set in [`.npmrc`](.npmrc).

1. **Make the packages available.** For local development, publish them to a local
   registry (verdaccio) and point `.npmrc` at it (already the default):

   ```bash
   # from the main repo root, publish the packages to your local registry:
   pnpm -r --filter "./workspaces/**" publish \
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

3. **Run** (client build + server, two processes):

   ```bash
   pnpm --filter @dbx-tools/demo-appkit-app dev      # vite dev server
   pnpm --filter @dbx-tools/demo-appkit-server dev   # tsx watch on the API
   ```

   The server serves the client's built `dist/` on the same port as the API.

## Required env

See [`.env.example`](.env.example). At minimum:

- `DATABRICKS_HOST`, `DATABRICKS_SERVING_ENDPOINT_NAME`, `DATABRICKS_GENIE_SPACE_ID`
- `LAKEBASE_*` / `PG*` for memory-backing Postgres
- SMTP (or `EMAIL_OUTBOX_MODE=1`) for the `send_email` tool

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
