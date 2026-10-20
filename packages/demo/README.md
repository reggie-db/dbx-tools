# Run the dbx-tools AppKit demo

Run a Databricks App that combines Genie, Mastra, Lakebase, Lakebox, search,
approval-gated email, durable memory, a Postgres message bus, and a React
client. The demo consumes the workspace packages directly, so package changes
are available without publishing them first.

```bash
bun install
uv sync --all-packages
test -f .env || cp packages/demo/.env.example .env
bun run demo -- -d
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). AppKit serves the React client and API from the
same origin. The `-d` option keeps AppKit and its sidecars running while Vite
updates client code through hot module replacement.

## Configure the demo

Before you run the demo, edit the repository-root `.env` file and authenticate
the profile named by `DATABRICKS_CONFIG_PROFILE`:

```bash
databricks auth login --profile <profile>
```

The main settings are:

| Setting                                       | Purpose                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABRICKS_HOST`                             | Databricks workspace URL.                                                                         |
| `DATABRICKS_CONFIG_PROFILE`                   | Explicit Databricks CLI profile for local workspace access.                                       |
| `DATABRICKS_GENIE_SPACE_ID`                   | Genie space used by the support agent and Genie-only chat.                                        |
| `DATABRICKS_SERVING_ENDPOINT_NAME`            | Optional model endpoint override. The model catalog selects an endpoint when this value is unset. |
| `LAKEBASE_ENDPOINT` or `LAKEBASE_PROJECT`     | Lakebase Autoscaling resource used by AppKit and Mastra persistence.                              |
| `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASSWORD` | SMTP delivery for approved email.                                                                 |
| `EMAIL_OUTBOX_MODE=1`                         | Write approved email to a local outbox instead of SMTP.                                           |
| `GRAPHITI_ENABLED=0`                          | Disable the Graphiti fallback for focused UI work.                                                |
| `BUS_ENABLED=0`                               | Disable the Postgres topic-bus example.                                                           |
| `REMOTE_SKILLS_ENABLED=0`                     | Disable remote skill loading.                                                                     |

For every available setting, see
[.env.example](.env.example).

## Run the development server

Run the following command from the repository root when you want server and
package changes to restart the process:

```bash
bun run demo
```

The watcher monitors the application and its workspace dependencies. Press
`r` to restart immediately. For client-only changes, use `bun run demo -- -d`
so Vite can update the browser without restarting Graphiti, the model gateway,
or the authenticated tunnel.

Local development sets `NODE_ENV=development`, which lets AppKit supply a
development user when the Databricks Apps front door is absent. For a deployed
entrance that authenticates a user without an on-behalf-of token, set
`MASTRA_GENIE_IDENTITY=auto`. This setting preserves per-user attribution and
uses the app service principal for Databricks calls that require credentials.

## Explore the app

The demo has the following pages:

- **Chat** switches one history-aware surface between the tool-using support
  agent and direct Genie conversations. The support agent can run approved
  generator tools for KPI-shaped data, dashboards, and standalone Genie spaces.
- **Lakebox** manages the current user's terminal, desktop, services, and
  machine metrics.
- **AI Search** uses Databricks AI Search when configured and a Lakebase
  full-text provider otherwise.
- **Message Bus** publishes Postgres topic messages and streams them to every
  open viewer.
- **Brand** streams researched brand-generation progress, applies the resulting
  context, and updates the application and email previews.

On desktop, each page includes a hideable guide pane with concrete use cases
and links to the corresponding section of the dbx-tools documentation.

The demo is one Bun workspace package with AppKit's conventional layout:

- [server](server) registers plugins, agents, tools, persistence, and routes.
- [client](client) renders the routed React application and persistent assistant.

The server uses the same plugin composition that consuming applications use:

```ts
import { genie, lakebase, server } from "@databricks/appkit";
import { createApp } from "@dbx-tools/appkit";
import { lakebox } from "@dbx-tools/appkit-lakebox";
import { memory } from "@dbx-tools/appkit-memory";
import { email } from "@dbx-tools/email";

await createApp({
  plugins: [server(), genie(), lakebase(), lakebox(), memory(), email()],
});
```

The complete registration, including Mastra agents, search providers, the
topic bus, and the tunnel gate, is in
[server/server.ts](server/server.ts).

## Deploy the demo

The deployment command validates the workspace, delegates source staging and
deployment to the Projen-owned AppKit task, applies the demo-specific catalog
grant, and starts the app:

```bash
bun run demo:deploy -- --profile <profile>
```

The profile must already be configured and authenticated. The
[databricks.yml](databricks.yml) file owns app resources,
bindings, and deployed environment variables. The
[app.yaml](app.yaml) file owns the runtime command. For
Databricks App deployment behavior, see
[Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/).

## Understand the operational limits

- The demo expects one workspace with access to the configured Genie space,
  SQL warehouse, model endpoints, Lakebase project, MLflow experiment, and
  secret scope.
- Genie Agent Mode requires an on-behalf-of user token. The configured
  `auto` identity policy falls back to the app service principal when the
  public tunnel provides identity without that token.
- The Lakebox plugin creates at most one Lakebox for the app. Each authenticated
  user receives a separate non-sudo account and service route.
- Graphiti starts only when Databricks managed memory is unavailable for the
  current actor. Disable Graphiti when you don't need that fallback.
- Email outbox mode records rendered messages for development. It doesn't send
  mail or reproduce attachment files on disk.
