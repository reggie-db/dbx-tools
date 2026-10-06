# `dbx-tools-graphiti`

Internal Python adapter for the Node-owned dbx-tools Graphiti runtime. The
package loads the pinned upstream Graphiti `0.29.3` MCP source, resolves shared
Databricks model settings through generated PythonMonkey bindings, and connects
Graphiti to the private FalkorDB Unix socket supplied by Node.

## Run Through The Owning CLI

Install and invoke the JavaScript owner:

```sh
bun add --global @dbx-tools/cli-graphiti
dbx-graphiti --profile MY-PROFILE
```

The Node launcher installs the matching Python package when needed, starts
durable embedded FalkorDB and the optional model gateway, then runs this adapter.
The default MCP endpoint is `http://127.0.0.1:8000/mcp/`.

## Understand The Boundary

This package does not own a second CLI schema, database process, persistence
policy, model gateway, desktop service, or AppKit lifecycle. Its generated
bindings consume the Zod contract from `@dbx-tools/shared-graphiti` and model
selection from `@dbx-tools/model`.

Upstream publishes `graphiti-core` but not the MCP application. This wheel
bundles the pinned MCP source tree so runtime downloads and tool bootstrapping
are unnecessary. `_upstream/SOURCE.json` records the exact upstream tag, source
path, and file hashes used by the package tests. Java, Neo4j, mise, uv project
environments, Honcho, Caddy, and PostgreSQL journaling are not part of this
package.

## Use With AppKit

Use [`@dbx-tools/appkit-graphiti`](../../js/node/appkit-graphiti) when Graphiti
runs beside an AppKit server. It reuses the Node runtime, publishes user-scoped
memory tools, and forwards the app's private identities without creating a
parallel Python service owner.

Direct Python callers should treat `dbx_tools.graphiti.cli` and generated Node
bindings as internal runtime boundaries. Start Graphiti through the JavaScript
CLI or AppKit plugin.
