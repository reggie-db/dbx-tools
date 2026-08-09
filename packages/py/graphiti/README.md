# `dbx-tools-graphiti`

Native launcher for [Graphiti](https://github.com/getzep/graphiti) with a local
Neo4j backend. It runs both services directly as host processes; it does not use
Docker, Podman, or another container runtime.

Install from PyPI:

```bash
uv add dbx-tools-graphiti
```

Or install the current `main` branch:

```bash
uv add "dbx-tools-graphiti @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/graphiti"
```

## Key features

- launches upstream Graphiti's HTTP MCP server at `http://127.0.0.1:8000/mcp/`;
- runs Neo4j Community 5.26 as a native background process;
- provisions Java 21 and `uv` through `mise use -g` only when absent;
- pins Graphiti and Neo4j versions for repeatable local environments;
- caches downloads, Python dependencies, Neo4j data, credentials, and logs;
- supports foreground or background operation without vendoring Graphiti code.

## Quick start

`mise` must already be installed. The launcher handles Java and `uv` itself.

```bash
export OPENAI_API_KEY=...
uv run dbx-graphiti start
```

The first run downloads about 120 MB of Neo4j plus the pinned Graphiti release,
creates Graphiti's `uv` environment, generates a local Neo4j password, starts
Neo4j, and then runs Graphiti in the foreground. Later runs reuse all of it.

For background operation:

```bash
uv run dbx-graphiti up
uv run dbx-graphiti status
uv run dbx-graphiti down
```

## Commands

| Command  | Behavior                                                                      |
| -------- | ----------------------------------------------------------------------------- |
| `setup`  | Provision tools and populate the local cache without starting services.       |
| `start`  | Start Neo4j, then run Graphiti in the foreground. This is the default.        |
| `up`     | Start both services in the background.                                        |
| `down`   | Stop the managed Graphiti and Neo4j processes.                                |
| `status` | Print process state and the MCP URL as JSON.                                  |
| `env`    | Print resolved Neo4j connection settings as JSON. Treat its output as secret. |

Arguments after `start` or `up` are forwarded to upstream Graphiti. For example:

```bash
uv run dbx-graphiti start -- --port 9000 --group-id my-agent
```

## Provisioning and caching

The package deliberately keeps orchestration separate from Graphiti itself:

1. It checks `mise where java@21` and `mise where uv@0.11`.
2. A missing tool is installed globally with `mise use -g --yes`.
3. Neo4j Community `5.26.12` is downloaded from `dist.neo4j.org` and unpacked.
4. Graphiti `v0.29.3` is downloaded from its GitHub release tag.
5. `uv sync --project <checkout>/mcp_server` creates the upstream environment.
6. A generated Neo4j password is stored with mode `0600` and supplied to
   Graphiti through its documented environment variables.

The cache root is:

- macOS: `~/Library/Application Support/dbx-tools/graphiti`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/dbx-tools/graphiti`
- Windows: `%LOCALAPPDATA%/dbx-tools/graphiti`

Set `DBX_GRAPHITI_HOME` to override it. Removing the directory clears the
download cache and permanently removes the local graph data.

## Configuration

The packaged default fixes the database provider to Neo4j and otherwise follows
upstream Graphiti environment names. Common settings are:

| Variable            | Default                  |
| ------------------- | ------------------------ |
| `OPENAI_API_KEY`    | Required                 |
| `MODEL_NAME`        | `gpt-4.1-mini`           |
| `EMBEDDER_MODEL`    | `text-embedding-3-small` |
| `GRAPHITI_GROUP_ID` | `main`                   |
| `GRAPHITI_HOST`     | `127.0.0.1`              |
| `GRAPHITI_PORT`     | `8000`                   |
| `NEO4J_URI`         | `bolt://127.0.0.1:7687`  |
| `NEO4J_DATABASE`    | `neo4j`                  |

Explicit `NEO4J_*` values override generated defaults, which lets the Graphiti
process use an existing Neo4j server. The launcher still manages its local
Neo4j process; use upstream Graphiti directly if lifecycle ownership belongs to
an external database administrator.

Graphiti owns MCP tools, graph behavior, LLM calls, embeddings, and migrations.
This package owns only repeatable installation, configuration, and process
lifecycle. See the [upstream MCP server documentation](https://github.com/getzep/graphiti/tree/main/mcp_server)
for its complete API and provider configuration.
