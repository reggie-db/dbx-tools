# dbx-tools-graphiti

Python runtime support for dbx-tools Graphiti integrations. This package runs
the pinned Graphiti MCP server, local Neo4j process, model-gateway connection,
and optional PostgreSQL write journal used by `@dbx-tools/cli-graphiti` and
`@dbx-tools/appkit-graphiti`.

The public command-line interface belongs to the JavaScript CLI package. The
Python `cli` module is an internal dispatcher that receives validated,
serialized configuration from that owner; it does not maintain a second option
parser or configuration schema.

## Run The Stack

Install and invoke the owning CLI:

```sh
bun add --global @dbx-tools/cli-graphiti
dbx-graphiti --profile MY-PROFILE
```

The launcher installs the matching Python package when needed, resolves the
selected Databricks models, starts the private model gateway and Neo4j, and then
launches Graphiti. The default MCP endpoint is
`http://127.0.0.1:8000/mcp/`.

For every supported command, environment variable, default, and option, use:

```sh
dbx-graphiti --help
dbx-graphiti start --help
```

The generated reference in
[`@dbx-tools/cli-graphiti`](../../js/cli/graphiti) comes from that same parser.

## Runtime Data

The runtime keeps Neo4j data, generated credentials, process state, and logs in
the Graphiti home directory. Defaults are:

- macOS: `~/Library/Application Support/dbx-tools/graphiti`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/dbx-tools/graphiti`

Set `DBX_GRAPHITI_HOME` or pass the CLI's `--home` option to use another
directory. Removing the directory removes the local graph.

## Durable Recovery

Local Neo4j is the active graph. When journal persistence is configured, graph
mutations are appended to PostgreSQL before they are delegated to Neo4j. On
startup, Graphiti replays the journal in sequence to rebuild an empty local
graph.

Use one journal namespace per logical graph. Replay is ordered and at least
once: a process failure can leave an attempted mutation in the journal even if
the original caller did not receive success. Graphiti's UUID-based mutations
work with this model; custom non-idempotent mutations must provide their own
replay safety.

The journal does not replicate writes to concurrent Graphiti instances and does
not compact itself. Do not delete old entries unless another complete recovery
snapshot exists.

## AppKit Integration

Use [`@dbx-tools/appkit-graphiti`](../../js/node/appkit-graphiti) when Graphiti
runs beside an AppKit server. It supervises the Python runtime and proxy,
publishes user-scoped memory tools, and uses the same shared Zod configuration
contract as the CLI.

Direct Python callers should treat `dbx_tools.graphiti.cli` and generated Node
bindings as internal runtime boundaries. Reuse the JavaScript CLI or AppKit
package instead of creating another Graphiti configuration owner.
