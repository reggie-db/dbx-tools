# `@dbx-tools/appkit-graphiti`

AppKit process plugin for the Python `dbx-tools-graphiti` MCP runtime.

## Key features

- starts Graphiti as a supervised AppKit sidecar;
- enables the Python Postgres write journal when the app supplies Lakebase or
  PostgreSQL connection environment;
- starts an internal loopback Caddy proxy in front of upstream Graphiti, then
  republishes the allowed tools through AppKit at `/api/graphiti/mcp`;
- derives a stable private Graphiti group from the AppKit user or Mastra memory
  resource id, overriding every caller-supplied group;
- exposes only operations that can be constrained to that group and removes
  UUID arguments that could reference another user's graph objects;
- selects separate free loopback ports for Graphiti, LiteLLM, and Caddy unless
  they are explicitly configured;
- exposes the user-scoped tools through `plugins.graphiti?.toolkit()` for
  `@dbx-tools/appkit-mastra` agents;
- runs Graphiti and Caddy under `concurrently`, while the Python launcher runs
  Graphiti and LiteLLM under Honcho;
- propagates termination signals through both supervisors, which escalate
  unresponsive process groups to `SIGKILL`;
- exposes the MCP path through plugin exports.

## Why use this over native AppKit

AppKit has no Graphiti or embedded MCP sidecar. This package owns AppKit routes
and process lifecycle while `dbx-tools-graphiti` owns Graphiti, Neo4j, LiteLLM,
and Postgres recovery.

## Register

Install `dbx-tools-graphiti` in the app's Python dependencies and register the
plugin:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { plugin as graphitiPlugin } from "@dbx-tools/appkit-graphiti";

await appkit.createApp({
  plugins: [server(), graphitiPlugin.graphiti()],
});
```

AppKit continues to listen on `DATABRICKS_APP_PORT`. The plugin adds a
user-scoped MCP server at `/api/graphiti/mcp`; Graphiti, LiteLLM, and Caddy
remain loopback-only. The plugin's manifest declares the Lakebase resource
requirements used by generated deployments, so Graphiti does not require a
separate `lakebase()` plugin. Local callers must still supply a Lakebase or
PostgreSQL connection environment to enable the journal.

Add the MCP tools to a Mastra agent with:

```ts
tools(plugins) {
  return { ...plugins.graphiti?.toolkit() };
}
```

The same resource id that scopes Mastra memory scopes every Graphiti operation
invoked as an agent tool. Direct MCP requests use the forwarded AppKit user id,
falling back to AppKit's service identity in local development. The plugin
hashes that identity before using it as a Graphiti group id. Model or MCP input
cannot choose `group_id` or `group_ids`.

The scoped surface includes memory ingestion, node/fact search, episode listing,
saga summaries, community building, triplet insertion, and status. UUID-only
read/delete operations and graph clearing are omitted from the agent and public
MCP surfaces.

## Configuration

Plugin config overrides environment values:

- `graphitiPort` / `GRAPHITI_PORT`: Graphiti's internal port; a free loopback
  port is selected automatically when omitted;
- `litellmPort` / `LITELLM_PORT`: the managed LiteLLM port; a separate free
  loopback port is selected automatically so another local proxy cannot be
  mistaken for Graphiti's model backend;
- `proxyPort` / `PROXY_PORT`: Caddy's internal port; a third free loopback port
  is selected automatically when omitted;
- `python` / `PYTHON`: Python executable, default `python3`;
- `journalNamespace` / `JOURNAL_NAMESPACE`: Postgres journal namespace, default
  `DATABRICKS_APP_NAME`, then the detected project name, then `default`.

The app must package both Node and Python dependencies. Databricks Apps supports
this directly with `package.json` plus `pyproject.toml` or `requirements.txt`.

## Modules

- `config` resolves sidecar ports, the Python command, and journal namespace;
- `plugin` starts and supervises Graphiti and Caddy.
