# `@dbx-tools/appkit-graphiti`

Run Graphiti beside an AppKit server, publish a user-scoped MCP surface, and
reuse the same Node-owned FalkorDB and direct model-routing runtime as the
standalone CLI.

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

The plugin resolves direct Databricks model routes, starts durable embedded
FalkorDB and the application-installed Python MCP adapter, and brokers refreshed
headers for the adapter on loopback. AppKit publishes the constrained MCP
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

Plugin config uses the composed `@dbx-tools/graphiti/options` schema. Common
fields include:

- `listen` / `GRAPHITI_LISTEN`: internal MCP listener; a free loopback port is
  selected automatically when omitted;
- `falkorDataDir` / `FALKORDB_DATA_DIR`: local active RDB directory;
- `falkorSnapshotSeconds`: change-aware RDB interval, default 300 seconds;
- `falkorSnapshotMinChanges`: minimum writes before a snapshot, default 1.

The package owns AppKit routing and app-scoped supervision only. Python process
launch and the reusable Graphiti runtime belong to
`@dbx-tools/graphiti/runtime`; FalkorDB durability belongs to
`@dbx-tools/falkor-db`.

## Operational Limits

Agent registration waits up to 60 seconds for MCP tool discovery. Startup
failure, an incomplete scoped tool set, or missing upstream descriptions and
schemas fails registration. The local RDB survives normal restarts, but callers
that need off-machine recovery should provide a storage policy through the
owning FalkorDB package rather than adding a second Graphiti journal.
