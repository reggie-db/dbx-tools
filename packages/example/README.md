# Run the dbx-tools AppKit demo

Run a Databricks App that combines Genie, Mastra, Lakebase, Lakebox, search,
approval-gated email, Microsoft Teams cards, durable memory, and a React client.
The demo consumes the workspace packages directly, so package changes are
available without publishing them first.

```bash
bun install
uv sync --all-packages
test -f .env || cp packages/example/server/appkit-demo/.env.example .env
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
| `DATABRICKS_GENIE_SPACE_ID`                   | Genie space used by the chat and card examples.                                                   |
| `DATABRICKS_SERVING_ENDPOINT_NAME`            | Optional model endpoint override. The model catalog selects an endpoint when this value is unset. |
| `LAKEBASE_ENDPOINT` or `LAKEBASE_PROJECT`     | Lakebase Autoscaling resource used by AppKit and Mastra persistence.                              |
| `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASSWORD` | SMTP delivery for approved email.                                                                 |
| `EMAIL_OUTBOX_MODE=1`                         | Write approved email to a local outbox instead of SMTP.                                           |
| `DBX_TOOLS_GRAPHITI_ENABLED=0`                | Disable the Graphiti fallback for focused UI work.                                                |
| `DBX_TOOLS_BUS_ENABLED=0`                     | Disable the Postgres topic-bus example.                                                           |
| `DBX_TOOLS_REMOTE_SKILLS_ENABLED=0`           | Disable remote skill loading.                                                                     |

For every available setting, see
[server/appkit-demo/.env.example](server/appkit-demo/.env.example).

## Run the development server

Run the following command from the repository root when you want server and
package changes to restart the process:

```bash
bun run demo
```

The watcher monitors the server package and its workspace dependencies. Press
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

- **Chat** compares Genie Agent Mode streaming with Conversation API polling.
  Both agents share the same tools, model selection, threads, and history.
- **Genie Chat** uses the Genie plugin directly, with Genie-owned
  conversations and visualizations.
- **Cards** sends the same agent questions through a Microsoft Teams Bot
  Framework envelope and renders Adaptive Cards.
- **Bus** publishes Postgres topic messages and streams them to every open
  viewer.
- **Search** uses Databricks AI Search when configured and a Lakebase full-text
  provider otherwise.
- **Brand** updates the application and email preview brand context.
- **Lakebox** manages the current user's terminal, desktop, services, and
  machine metrics.

The server and client are separate workspace packages:

| Package                                  | Purpose                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| [server/appkit-demo](server/appkit-demo) | Registers AppKit plugins, agents, tools, persistence, and deployment resources. |
| [app/appkit-demo](app/appkit-demo)       | Renders the routed React application and persistent assistant.                  |

The server uses the same plugin composition that consuming applications use:

```ts
import { genie, lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { lakebox } from "@dbx-tools/appkit-lakebox";
import { memory } from "@dbx-tools/appkit-memory";
import { email } from "@dbx-tools/email";
import { teams } from "@dbx-tools/teams";

await appkit.createApp({
  plugins: [server(), genie(), lakebase(), lakebox(), memory(), email(), teams()],
});
```

The complete registration, including Mastra agents, search providers, the
topic bus, and the tunnel gate, is in
[server/appkit-demo/src/server.ts](server/appkit-demo/src/server.ts).

## Test the Teams endpoint

In development, the demo allows unauthenticated Bot Framework activities so
you can test the Teams route without an Azure Bot registration:

```bash
curl --request POST http://127.0.0.1:8000/api/teams/messages \
  --header 'content-type: application/json' \
  --data '{"type":"message","text":"summarize today","from":{"id":"user-1"},"conversation":{"id":"conv-1"}}'
```

`allowUnauthenticated` applies only when `NODE_ENV=development`. A deployed
Teams bot must configure `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD`. For the
protocol and delivery behavior, see
[@dbx-tools/teams](../js/node/teams/README.md).

## Deploy the demo

The deployment command compiles the workspace, builds the Python wheels,
stages a self-contained source tree, validates the bundle, deploys the app, and
starts it:

```bash
bun run demo:deploy -- --profile <profile>
```

The profile must already be configured and authenticated. The
[databricks.yml](server/appkit-demo/databricks.yml) file owns app resources,
bindings, and deployed environment variables. The
[app.yaml](server/appkit-demo/app.yaml) file owns the runtime command. For
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
