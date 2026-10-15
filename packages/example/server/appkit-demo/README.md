# Run the demo AppKit server

This package registers the backend for the dbx-tools demo. It exposes Mastra
and direct Genie chat, Lakebox services, Lakebase persistence, search, email,
a Postgres topic bus, and the React client from one AppKit process.

```ts
import { genie, lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { lakebox } from "@dbx-tools/appkit-lakebox";
import { agents, mastra } from "@dbx-tools/appkit-mastra";
import { memory } from "@dbx-tools/appkit-memory";
import { email, emailTool } from "@dbx-tools/email";

const support = agents.createAgent({
  name: "Support",
  instructions: "Answer questions with the registered tools.",
  async tools(plugins) {
    return {
      ...((await plugins.genie?.toolkit()) ?? {}),
      ...((await plugins.memory?.toolkit()) ?? {}),
      send_email: emailTool(),
    };
  },
});

await appkit.createApp({
  plugins: [
    server(),
    genie(),
    lakebase(),
    lakebox(),
    memory(),
    email(),
    mastra({ agents: { support } }),
  ],
});
```

The full server in [src/server.ts](src/server.ts) adds search providers, the
topic bus, Lakebox skill mounts, the public tunnel, and deployment-specific
identity policy.

## Run the server

Run the demo from the repository root so Bun can use the generated workspace
and root tasks:

```bash
bun install
uv sync --all-packages
test -f .env || cp packages/example/server/appkit-demo/.env.example .env
bun run demo
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). AppKit serves Vite middleware and API routes from
this port. For client-only work, run `bun run demo -- -d` to disable server
restarts while retaining Vite hot module replacement.

You can disable optional services and use the local email outbox:

```bash
DBX_TOOLS_GRAPHITI_ENABLED=0 \
DBX_TOOLS_BUS_ENABLED=0 \
DBX_TOOLS_REMOTE_SKILLS_ENABLED=0 \
EMAIL_OUTBOX_MODE=1 \
bun run demo -- -d
```

## Configure Databricks resources

Copy [.env.example](.env.example) to the repository-root `.env` file, then
set the following values:

| Setting                            | Purpose                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `DATABRICKS_HOST`                  | Workspace URL.                                                              |
| `DATABRICKS_CONFIG_PROFILE`        | Authenticated Databricks CLI profile for local development.                 |
| `DATABRICKS_GENIE_SPACE_ID`        | Default Genie space for agent tools and direct Genie chat.                  |
| `DATABRICKS_SERVING_ENDPOINT_NAME` | Optional model endpoint override.                                           |
| `LAKEBASE_ENDPOINT`                | Lakebase Autoscaling endpoint used by AppKit, Mastra, search, and Graphiti. |
| `DATABRICKS_AGENT_MEMORY_STORE_ID` | Optional Databricks managed-memory store.                                   |
| `SMTP_*` and `EMAIL_DOMAIN`        | SMTP transport and sender policy.                                           |

Authenticate the selected profile before you start the server:

```bash
databricks auth login --profile <profile>
```

The deployed app receives these values through resource bindings and
`resources.apps.demo_app.config.env` in
[databricks.yml](databricks.yml). [app.yaml](app.yaml) contains only the
Node runtime command.

## Use the registered capabilities

The server registers one `support` agent with the Genie toolkit, durable memory,
Lakebox, search, email, model selection, typed request context, and Mastra thread
storage. The direct `/genie/:alias/*` routes keep Genie-only conversations in
Genie instead of Mastra.

The email tool pauses a turn until the user approves or rejects the send.
`email()` validates the SMTP connection during startup. Set
`EMAIL_OUTBOX_MODE=1` when you want to test approval without sending mail.

`memory()` checks Databricks managed memory first. In automatic mode, a 403 or
404 selects the Graphiti fallback for that actor. Other managed-memory errors
remain errors.

`busDemo()` exposes the following routes:

- `POST /api/bus-demo/messages` publishes a typed topic message.
- `GET /api/bus-demo/events` streams new messages to connected browsers.

## Deploy the server

Run the repository deployment task with an explicit profile:

```bash
bun run demo:deploy -- --profile <profile>
```

The task compiles the workspace, stages local npm archives and Python wheels,
validates the bundle, deploys the app, and runs the `demo_app` resource. It
doesn't upload `node_modules`.

If the app exists but isn't bound to this bundle state, bind it once before
the next deployment:

```bash
databricks bundle deployment bind demo_app dbx-tools-demo \
  --target dev \
  --profile <profile>
```

## Understand server limits

- Local development uses AppKit's development identity. Production user-scoped
  routes require the Databricks Apps front door or another authenticated
  entrance.
- Direct Genie chat requires an on-behalf-of token. The Mastra agents can use
  `MASTRA_GENIE_IDENTITY=auto` to fall back to the app service principal when a
  tunnel supplies identity without a Databricks token.
- AppKit shuts down the Graphiti sidecar, Lakebox runtime, topic bus, tunnel,
  and other plugin resources with the server process.
