# `@dbx-tools/appkit-graphiti`

Run Graphiti beside an AppKit server, publish a user-scoped MCP surface, and
reuse the same unified Python runtime as the standalone CLI.

## Register The Plugin

Install the Node package and include `dbx-tools-graphiti` in the application's
Python dependencies so the exact adapter is available without runtime package
installation:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { graphiti } from "@dbx-tools/appkit-graphiti";

await appkit.createApp({
  plugins: [server(), graphiti()],
});
```

The plugin starts the application-installed Python runtime, which owns model
routing and durable embedded storage. AppKit publishes the constrained MCP
endpoint at `/api/graphiti/mcp`.

## Add Agent Tools

Expose the discovered Graphiti tools to an AppKit Mastra agent:

```ts
async tools(plugins) {
  return { ...(await plugins.graphiti?.toolkit()) };
}
```

The plugin hashes the AppKit user or Mastra resource id into a private Graphiti
group. It overwrites caller-supplied group fields, removes UUID arguments that
could reference another user's graph, and exposes only operations that can be
constrained to the derived group.

## Configure Sidecars

Plugin config uses the shared Graphiti schema. Common fields include:

- `listen` / `GRAPHITI_LISTEN`: internal MCP listener; a free loopback port is
  selected automatically when omitted;
- `graphitiHome` / `GRAPHITI_HOME`: persistent embedded PostgreSQL directory;
- `databaseUrl` / `DATABASE_URL`: optional external PostgreSQL URL or Lakebase
  target.

The package owns AppKit routing and app-scoped supervision only. Python process
launch and the reusable Graphiti runtime belong to
`@dbx-tools/graphiti/runtime`; the Python Graphiti package owns the PostGraph
driver and PostgreSQL lifecycle.

## Operational Limits

Agent registration waits up to 60 seconds for MCP tool discovery. Startup
failure, an incomplete scoped tool set, or missing upstream descriptions and
schemas fails registration. PostgreSQL owns graph durability and recovery.
