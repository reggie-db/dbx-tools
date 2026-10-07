# `@dbx-tools/appkit-graphiti`

Run Graphiti beside an AppKit server, publish direct user-scoped memory tools,
and reuse the same unified Python runtime as the standalone CLI.

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

The plugin reads the Python runtime's OpenAPI document before registration, then
starts the application-installed runtime that owns model routing and durable
embedded storage. Tool calls use direct loopback HTTP instead of MCP discovery
and transport.

## Add Agent Tools

Expose the OpenAPI-derived Graphiti tools to an AppKit Mastra agent:

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

- `listen` / `GRAPHITI_LISTEN`: internal HTTP listener; a free loopback port is
  selected automatically when omitted;
- `graphitiHome` / `GRAPHITI_HOME`: persistent embedded PostgreSQL directory;
- `databaseUrl` / `DATABASE_URL`: optional external PostgreSQL URL or Lakebase
  target.

The package owns AppKit routing and app-scoped supervision only. Python process
launch and the reusable Graphiti runtime belong to
`@dbx-tools/graphiti/runtime`; the Python Graphiti package owns the PostGraph
driver and PostgreSQL lifecycle.

## Operational Limits

OpenAPI extraction must publish every scoped operation before AppKit setup
completes. Tool execution waits up to 60 seconds for the Graphiti healthcheck.
Startup failure or an incomplete tool contract fails registration. PostgreSQL
owns graph durability and recovery.
