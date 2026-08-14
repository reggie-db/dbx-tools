# `dbx-tools-graphiti`

Native launcher for [Graphiti](https://github.com/getzep/graphiti) with local
Neo4j and LiteLLM processes configured for Databricks Model Serving. It runs
directly on the host without Docker, Podman, or another container runtime.

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
- starts `dbx-tools-litellm` with an optional CLI profile, the configured CLI
  default, or ambient Databricks App authentication;
- supervises Graphiti and managed LiteLLM with Honcho so they share one
  lifecycle, receive SIGTERM as process groups, and receive SIGKILL after
  Honcho's bounded shutdown grace if needed;
- journals successful graph mutations to Postgres and reconstructs an
  ephemeral graph backend during startup;
- defaults to `databricks-gpt-5-nano` and the 1024-dimensional
  `databricks-gte-large-en` embedding model;
- reuses executables from `PATH` and installs missing Java 21, uv, Neo4j, and
  Graphiti source through mise;
- pins Graphiti and Neo4j versions for repeatable local environments;
- caches downloads, Python dependencies, Neo4j data, credentials, and logs;
- needs no caller-owned `config.yaml` and does not vendor Graphiti code.

## Quick start

Outside a Databricks App, configure a working Databricks CLI profile. A
Databricks App uses its ambient service-principal authentication. The launcher
installs mise when needed, handles Java, LiteLLM, Graphiti, and Neo4j, and
installs `uv` only when it is not already available:

```bash
uv run dbx-graphiti start
```

The launcher uses `DATABRICKS_CONFIG_PROFILE` when set. Otherwise it runs
`databricks auth profiles --output json --skip-validate` and uses the one entry
marked `"default": true`. `--profile <name>` is an optional override, not a
requirement.

The first run downloads about 120 MB of Neo4j plus the pinned Graphiti release,
creates Graphiti's `uv` environment, generates a local Neo4j password, starts
LiteLLM and Neo4j, and then runs Graphiti in the foreground. Later runs reuse
the installed assets.

Honcho stops the sibling process when Graphiti or managed LiteLLM exits. On
Ctrl-C or SIGTERM it forwards SIGTERM to each child process group, waits up to
five seconds, then sends SIGKILL to any remaining group. The launcher stops
Neo4j after Honcho finishes.

For background operation:

```bash
uv run dbx-graphiti up
uv run dbx-graphiti status
uv run dbx-graphiti down
```

## Commands

- `start` starts Neo4j, then runs Graphiti and managed LiteLLM under Honcho in
  the foreground. Missing prerequisites are installed on demand. This is the
  default.
- `up` starts all three services in the background.
- `down` signals the Honcho supervisor, which stops Graphiti and managed
  LiteLLM before the launcher stops Neo4j.
- `status` prints process state, model selection, and the MCP URL as JSON.
- `env` prints resolved database, proxy, and model settings as JSON. Its output
  includes the Neo4j password and must be treated as secret.

Arguments after `--` are forwarded to upstream Graphiti:

```bash
uv run dbx-graphiti start -- --port 9000 --group-id my-agent
```

## Postgres persistence

`DelegatingGraphDriver` accepts any Graphiti `GraphDriver` and delegates its
provider behavior, operations, sessions, transactions, search, and maintenance
to that driver. Mutating Cypher statements are appended to a supplied ordered
storage driver before the graph operation or transaction commits. During the
first index setup, the wrapper clears the delegated graph and replays the
stored mutations in order without journaling them again.

`PostgresWriteStorage` provides the durable implementation. It stores a
namespaced append-only JSONB journal and accepts the async SQLAlchemy engine
created by `dbx-tools-postgres`:

```python
from databricks.sdk import WorkspaceClient
from dbx_tools.graphiti.persistence import (
    DelegatingGraphDriver,
    PostgresWriteStorage,
)
from dbx_tools.postgres import create_async_engine

engine = create_async_engine(WorkspaceClient(), pool_pre_ping=True)
storage = PostgresWriteStorage(engine, namespace="memory-service")
driver = DelegatingGraphDriver(graph_driver, storage)
```

The bundled MCP launcher enables this automatically when any of these settings
is present:

- `JOURNAL_DATABASE_URL`: explicit PostgreSQL URL. The launcher uses asyncpg.
- `PGHOST`, `LAKEBASE_ENDPOINT`, or `LAKEBASE_INSTANCE_NAME`: resolve the
  connection and rotating credential through `dbx-tools-postgres` and
  `WorkspaceClient`.
- `JOURNAL_NAMESPACE`: isolates one journal within the table. The launcher
  derives a stable value from its data directory when omitted. A direct
  `dbx_tools.graphiti.server` invocation must set it explicitly.
- `JOURNAL_TABLE`: journal table name. Defaults to
  `graphiti_write_journal`.

When persistence is configured, Postgres initialization or replay failure stops
server startup rather than running without durability. The journal is restart
recovery for one live graph instance. It does not replicate new writes into
other concurrently running Graphiti instances. A process crash after the graph
write-ahead append but before the graph commit can leave an unacknowledged
mutation in the journal; restart recovery applies journal entries at least once.
Graphiti's UUID-backed mutation queries are compatible with this replay model,
but a custom delegate or write predicate must supply replay-safe mutations.
If the local Neo4j credential no longer matches its ephemeral data directory,
the launcher resets that directory only when a Postgres journal is configured,
then Graphiti rebuilds it from the journal. Without durable storage, an
authentication mismatch fails startup rather than deleting local graph data.

## Provisioning and caching

The package deliberately keeps orchestration separate from Graphiti itself:

1. `dbx_tools.core.bin` checks `PATH` before asking mise for a tool.
2. When mise is missing on macOS or Linux, the official checksum-verifying
   installer runs under a cross-process lock.
3. Missing tools are installed globally with `mise use -g --yes`, then resolved
   with `mise which` or `mise where`.
4. Java `21`, uv `0.11`, and Neo4j Community `5.26.12` use their mise registry
   backends.
5. Graphiti `0.29.3` uses mise's HTTP backend against the pinned release source
   archive because the GitHub release has no platform binary asset.
6. `uv sync --project <checkout>/mcp_server` creates the upstream environment.
7. A generated Neo4j password is stored with mode `0600`.
8. The packaged LiteLLM proxy starts against the selected Databricks profile,
   and Graphiti receives its OpenAI-compatible URL and model settings through
   environment variables and CLI flags.

The launcher is supported on macOS and Linux. The cache root is:

- macOS: `~/Library/Application Support/dbx-tools/graphiti`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/dbx-tools/graphiti`

Set `DBX_GRAPHITI_HOME` to override it. The directory contains links to the
mise-managed tools plus launcher state, logs, and Neo4j data. Removing it
permanently removes the local graph data; mise manages its own download cache
and installation directories separately.

## Configuration

Callers do not supply a Graphiti `config.yaml`. The server creates an empty
temporary YAML file for the lifetime of the upstream process because upstream
requires the argument. Model and server settings resolve from CLI option,
environment variable, then package default:

- `--profile` / `DATABRICKS_CONFIG_PROFILE`: an optional Databricks profile
  override for managed LiteLLM. When both are absent, the launcher uses the
  Databricks CLI profile marked as default.
- `--model` / `MODEL_NAME`: defaults to
  `dbx/databricks-gpt-5-nano`.
- `--embedder-model` / `EMBEDDER_MODEL`: defaults to
  `dbx/databricks-gte-large-en`.
- `--embedder-dimensions` / `EMBEDDER_DIMENSIONS`: defaults to `1024`.
- `--litellm-host` / `LITELLM_HOST`: defaults to `127.0.0.1`.
- `--litellm-port` / `LITELLM_PORT`: defaults to `4000`.
- `--litellm-url` / `LITELLM_URL`: selects an external OpenAI-compatible
  LiteLLM endpoint.
- `--manage-litellm`, `--no-manage-litellm` / `MANAGE_LITELLM`: explicitly
  controls whether the launcher owns the proxy.
- `LLM_STRUCTURED_OUTPUT_MODE`: defaults to `json_object`.
- `GRAPHITI_GROUP_ID`: defaults upstream to `main`.
- `GRAPHITI_HOST` and `GRAPHITI_PORT`: environment-only listener settings.
  Without a port, the launcher uses `DATABRICKS_APP_PORT` when present and
  `8000` otherwise. Without a host, it binds `0.0.0.0` in a Databricks App and
  `127.0.0.1` elsewhere. The AppKit plugin selects a loopback endpoint for both.
- `NEO4J_URI` and `NEO4J_DATABASE`: default to
  `bolt://127.0.0.1:7687` and `neo4j`.

The launcher sets Graphiti's OpenAI provider and embedding dimensions directly.
No OpenAI key is required for its managed local proxy.

To use a separately managed LiteLLM instance:

```bash
uv run dbx-graphiti start \
  --litellm-url https://models.example/v1 \
  --no-manage-litellm
```

Setting `LITELLM_URL` also selects external mode automatically. A direct
`OPENAI_API_URL` selects external OpenAI-compatible mode and requires
`OPENAI_API_KEY`. `--manage-litellm` overrides either environment choice when
the launcher should still own the local proxy.

Explicit `NEO4J_*` values override generated defaults, which lets the Graphiti
process use an existing Neo4j server. The launcher still manages its local
Neo4j process; use upstream Graphiti directly if lifecycle ownership belongs to
an external database administrator.

Graphiti owns MCP tools, graph behavior, LLM calls, embeddings, and migrations.
This package owns repeatable installation, Databricks defaults, and process
lifecycle. To run it beside an AppKit server through one Databricks App port,
use [`@dbx-tools/appkit-graphiti`](../../js/node/appkit-graphiti). See the
[upstream MCP server documentation](https://github.com/getzep/graphiti/tree/main/mcp_server)
for its complete API.

## Modules

- `cli`: Cyclopts commands and CLI-over-environment option binding;
- `settings`: model, embedding, profile, and LiteLLM resolution;
- `runtime`: on-demand provisioning and Honcho lifecycle;
- `server`: upstream MCP entry point, temporary config, and persistence wiring;
- `proxy`: loopback Caddy process used by the AppKit plugin;
- `persistence`: delegating graph driver and Postgres write-ahead journal;
- `supervisor`: detached `up` entry point.
