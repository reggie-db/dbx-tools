# `@dbx-tools/appkit-graphiti`

AppKit process plugin for the Python `dbx-tools-graphiti` MCP runtime.

## Key features

- starts Graphiti as a supervised AppKit sidecar;
- inherits the Lakebase environment resolved by `@dbx-tools/appkit` and native
  `lakebase()`, enabling the Python Postgres write journal automatically;
- starts mise-managed Caddy on `DATABRICKS_APP_PORT`;
- routes `/graphiti/*` to Graphiti and all other traffic to AppKit;
- selects a free loopback port for Graphiti unless one is explicitly configured;
- discovers the upstream MCP tools and exposes them through
  `plugins.graphiti?.toolkit()` for Mastra and AppKit agents;
- binds both child processes to the shared concurrently-style supervisor so
  signals propagate and any child exit tears down the app;
- exposes the internal AppKit port and public MCP path through plugin exports.

## Why use this over native AppKit

AppKit has no Graphiti or embedded MCP sidecar. This package owns AppKit process
lifecycle and single-port routing while `dbx-tools-graphiti` owns
Graphiti, Neo4j, LiteLLM, and Postgres recovery.

## Register

Install `dbx-tools-graphiti` in the app's Python dependencies, then register
native `lakebase()` before the Graphiti plugin:

```ts
import { lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { config as graphitiConfig, plugin as graphitiPlugin } from "@dbx-tools/appkit-graphiti";

const graphiti = graphitiConfig.resolveGraphitiConfig();

await appkit.createApp({
  plugins: [
    server({ host: "127.0.0.1", port: graphiti.appPort }),
    lakebase(),
    graphitiPlugin.graphiti(graphiti),
  ],
});
```

The public MCP endpoint is `/graphiti/mcp/`. Caddy listens on the platform's
`DATABRICKS_APP_PORT`; AppKit and Graphiti remain loopback-only.

Add the MCP tools to a Mastra agent with:

```ts
tools(plugins) {
  return { ...plugins.graphiti?.toolkit() };
}
```

## Configuration

Plugin config overrides environment values:

- `publicPort` / `DATABRICKS_APP_PORT`: Caddy's public port, default `8000`;
- `appPort` / `GRAPHITI_APP_PORT`: AppKit's internal port, default public + 1;
- `graphitiPort` / `GRAPHITI_PORT`: Graphiti's internal port; a free loopback
  port is selected automatically when omitted;
- `litellmPort` / `LITELLM_PORT`: the managed LiteLLM port; a separate free
  loopback port is selected automatically so another local proxy cannot be
  mistaken for Graphiti's model backend;
- `routePrefix` / `GRAPHITI_ROUTE_PREFIX`: public Graphiti prefix, default
  `/graphiti`;
- `python` / `PYTHON`: Python executable, default `python3`;
- `journalNamespace` / `JOURNAL_NAMESPACE`: Postgres journal namespace, default
  `DATABRICKS_APP_NAME` then `default`.

The app must package both Node and Python dependencies. Databricks Apps supports
this directly with `package.json` plus `requirements.txt`.

## Modules

- `config` resolves ports, process command, route prefix, and journal namespace;
- `plugin` starts and supervises Graphiti and Caddy.
