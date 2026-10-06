# dbx-tools-graphiti

Run Graphiti's MCP memory service with local Neo4j and Databricks-hosted models.
The launcher prepares the backend and model gateway, keeps their lifecycles
aligned, and can journal graph writes to Postgres for recovery across restarts.

## Start The Memory Service

Install the Python package and make the model gateway executable available:

```sh
uv add dbx-tools-graphiti
bun add --global @dbx-tools/cli-model-gateway
uv run python -m dbx_tools.graphiti start --profile MY-PROFILE
```

Use a Databricks profile that can access the selected models. In a Databricks
App, the runtime can use the app's service-principal credentials instead.

The MCP endpoint defaults to `http://127.0.0.1:8000/mcp/`. The first start
prepares Java, Neo4j, and the Graphiti environment and may take several minutes;
later starts reuse the installed assets. Keep the terminal open for foreground
operation. Ctrl-C stops Graphiti, its managed model gateway, and Neo4j together.

For a Bun launcher or an installed desktop service, use
[`@dbx-tools/cli-graphiti`](../../js/cli/graphiti).

## Select Models Or Reuse A Gateway

```sh
uv run python -m dbx_tools.graphiti start --profile MY-PROFILE --model databricks-gpt-5
uv run python -m dbx_tools.graphiti start --model-gateway-url http://127.0.0.1:4000/v1 --no-manage-model-gateway
```

Use `--embedder-model` and `--embedder-dimensions` together when changing the
embedding model. The generated reference lists all model and gateway options
and their environment-variable equivalents.

Arguments after `--` are forwarded to the upstream Graphiti server:

```sh
uv run python -m dbx_tools.graphiti start --profile MY-PROFILE -- --port 9000 --group-id my-agent
```

## Run In The Background

```sh
uv run python -m dbx_tools.graphiti up --profile MY-PROFILE
uv run python -m dbx_tools.graphiti status
uv run python -m dbx_tools.graphiti down
```

`status` prints process state, selected models, and the MCP URL as JSON.
`down` stops the background stack. Use `env` to inspect resolved connection
settings, but treat its output as secret because it includes the Neo4j password.

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
from dbx_tools.graphiti.persistence import (
    DelegatingGraphDriver,
    PostgresWriteStorage,
)
from dbx_tools.postgres.engine import create_async_engine, create_workspace_client

workspace = await create_workspace_client()
engine = create_async_engine(workspace, pool_pre_ping=True)
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
  `dbx_tools_graphiti.graphiti_write_journal`. A schema-qualified table causes
  the journal to create that schema when absent, avoiding Lakebase deployments
  where the application identity cannot write to `public`.

When persistence is configured, Postgres initialization or replay failure stops
server startup rather than running without durability. The contract is
write-ahead attempt recovery with ordered, at-least-once replay:

- a direct write is appended before the delegated mutation;
- a transaction callback is buffered as one journal append before the delegate
  commits, so a later commit failure retains that attempted batch;
- a driver retry invokes the callback again and records another attempt;
- replay runs entries in sequence after clearing the ephemeral graph and stops
  on the first invalid entry. Nothing is skipped or marked complete, so a later
  startup retries the same entry;
- transaction batch boundaries are atomic in Postgres at append time but are
  not retained as replay groups. Replay executes each statement in sequence;
- `clone()` and `with_database()` represent another view of the same logical
  graph and share the journal without taking storage ownership. Independent
  graphs require distinct storage namespaces;
- the journal is append-only and has no checkpoint, retention, or compaction
  policy. Deleting old entries without an external full snapshot makes replay
  incomplete.

The journal is restart recovery for one live graph instance. It does not
replicate new writes into other concurrently running Graphiti instances. A
process crash after the graph write-ahead append but before the graph commit can
leave an unacknowledged mutation in the journal. Graphiti's UUID-backed mutation
queries are compatible with this replay model, but a custom delegate or write
predicate must supply replay-safe mutations. Non-idempotent writes can be
applied more than once and are outside this contract.
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
6. `uv sync --python <launcher-minor> --project <checkout>/mcp_server`
   creates the upstream environment on the same Python minor as the
   launcher (or `UV_PYTHON` when set). The Graphiti child imports this
   package from the launcher `PYTHONPATH`, including the workspace roots
   for `dbx_tools.postgres`, so a looser upstream `requires-python` must
   not select a different interpreter.
7. A generated Neo4j password is stored with mode `0600`.
8. The TypeScript AppKit model gateway starts against the selected Databricks profile,
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

- `--profile`: an optional explicit Databricks profile override. When absent,
  dbx-tools auth resolves the active Databricks identity.
- `--model` / `MODEL_NAME`: defaults to
  `databricks-gpt-5-nano`.
- `--embedder-model` / `EMBEDDER_MODEL`: defaults to
  `databricks-gte-large-en`.
- `--embedder-dimensions` / `EMBEDDER_DIMENSIONS`: defaults to `1024`.
- `--model-gateway-host` / `MODEL_GATEWAY_HOST`: defaults to `127.0.0.1`.
- `--model-gateway-port` / `MODEL_GATEWAY_PORT`: defaults to `4400`.
- `--model-gateway-url` / `MODEL_GATEWAY_URL`: selects an external OpenAI-compatible
  endpoint.
- `--manage-model-gateway`, `--no-manage-model-gateway` / `MANAGE_MODEL_GATEWAY`: explicitly
  controls whether the launcher owns the gateway.
- `MODEL_GATEWAY_COMMAND`: executable and arguments used for managed mode.
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

To use a separately managed OpenAI-compatible proxy:

```bash
uv run dbx-graphiti start \
  --model-gateway-url https://models.example/v1 \
  --no-manage-model-gateway
```

Setting `MODEL_GATEWAY_URL` also selects external mode automatically. A direct
`OPENAI_API_URL` selects external OpenAI-compatible mode and requires
`OPENAI_API_KEY`. `--manage-model-gateway` overrides either environment choice when
the launcher should still own the local gateway.

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
- `settings`: model, embedding, profile, and model-gateway resolution;
- `runtime`: on-demand provisioning and Honcho lifecycle;
- `server`: upstream MCP entry point, temporary config, and persistence wiring;
- `proxy`: loopback Caddy process used by the AppKit plugin;
- `persistence`: delegating graph driver and Postgres write-ahead journal;
- `supervisor`: detached `up` entry point.

<!-- cli-reference:start -->

## Command Reference

### `python -m dbx_tools.graphiti`

Run Graphiti MCP with a local native Neo4j backend (no containers).

```sh
python -m dbx_tools.graphiti
```

#### Commands

| Command  | Description                                                     |
| -------- | --------------------------------------------------------------- |
| `start`  | Start Neo4j, the model gateway, and Graphiti.                   |
| `up`     | Start Neo4j, the model gateway, and Graphiti in the background. |
| `down`   | Stop Graphiti, the model gateway, and Neo4j.                    |
| `status` | Show native process status.                                     |
| `env`    | Print resolved runtime settings, including the Neo4j password.  |

### `python -m dbx_tools.graphiti start`

Start Neo4j, the model gateway, and Graphiti.

```sh
python -m dbx_tools.graphiti start
```

#### Options

| Option                                              | Description                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--profile`                                         | Databricks profile used by the managed model gateway.                                                               |
| `--model`                                           | Model used to extract and query graph memory. (env: MODEL_NAME)                                                     |
| `--embedder-model`                                  | Embedding model used to index graph memory. (env: EMBEDDER_MODEL)                                                   |
| `--embedder-dimensions`                             | Number of dimensions returned by the embedding model. (env: EMBEDDER_DIMENSIONS)                                    |
| `--model-gateway-url`                               | Existing OpenAI-compatible gateway URL, including /v1. (env: MODEL_GATEWAY_URL)                                     |
| `--model-gateway-host`                              | Host for the locally managed model gateway. (env: MODEL_GATEWAY_HOST)                                               |
| `--model-gateway-port`                              | Port for the locally managed model gateway. (env: MODEL_GATEWAY_PORT)                                               |
| `--model-gateway-command`                           | Command used to launch the managed model gateway. (env: MODEL_GATEWAY_COMMAND)                                      |
| `--manage-model-gateway, --no-manage-model-gateway` | Start and stop a local model gateway with Graphiti; disable to use an existing gateway. (env: MANAGE_MODEL_GATEWAY) |

### `python -m dbx_tools.graphiti up`

Start Neo4j, the model gateway, and Graphiti in the background.

```sh
python -m dbx_tools.graphiti up
```

#### Options

| Option                                              | Description                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--profile`                                         | Databricks profile used by the managed model gateway.                                                               |
| `--model`                                           | Model used to extract and query graph memory. (env: MODEL_NAME)                                                     |
| `--embedder-model`                                  | Embedding model used to index graph memory. (env: EMBEDDER_MODEL)                                                   |
| `--embedder-dimensions`                             | Number of dimensions returned by the embedding model. (env: EMBEDDER_DIMENSIONS)                                    |
| `--model-gateway-url`                               | Existing OpenAI-compatible gateway URL, including /v1. (env: MODEL_GATEWAY_URL)                                     |
| `--model-gateway-host`                              | Host for the locally managed model gateway. (env: MODEL_GATEWAY_HOST)                                               |
| `--model-gateway-port`                              | Port for the locally managed model gateway. (env: MODEL_GATEWAY_PORT)                                               |
| `--model-gateway-command`                           | Command used to launch the managed model gateway. (env: MODEL_GATEWAY_COMMAND)                                      |
| `--manage-model-gateway, --no-manage-model-gateway` | Start and stop a local model gateway with Graphiti; disable to use an existing gateway. (env: MANAGE_MODEL_GATEWAY) |

### `python -m dbx_tools.graphiti down`

Stop Graphiti, the model gateway, and Neo4j.

```sh
python -m dbx_tools.graphiti down
```

### `python -m dbx_tools.graphiti status`

Show native process status.

```sh
python -m dbx_tools.graphiti status
```

### `python -m dbx_tools.graphiti env`

Print resolved runtime settings, including the Neo4j password.

```sh
python -m dbx_tools.graphiti env
```

#### Options

| Option                                              | Description                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--profile`                                         | Databricks profile used by the managed model gateway.                                                               |
| `--model`                                           | Model used to extract and query graph memory. (env: MODEL_NAME)                                                     |
| `--embedder-model`                                  | Embedding model used to index graph memory. (env: EMBEDDER_MODEL)                                                   |
| `--embedder-dimensions`                             | Number of dimensions returned by the embedding model. (env: EMBEDDER_DIMENSIONS)                                    |
| `--model-gateway-url`                               | Existing OpenAI-compatible gateway URL, including /v1. (env: MODEL_GATEWAY_URL)                                     |
| `--model-gateway-host`                              | Host for the locally managed model gateway. (env: MODEL_GATEWAY_HOST)                                               |
| `--model-gateway-port`                              | Port for the locally managed model gateway. (env: MODEL_GATEWAY_PORT)                                               |
| `--model-gateway-command`                           | Command used to launch the managed model gateway. (env: MODEL_GATEWAY_COMMAND)                                      |
| `--manage-model-gateway, --no-manage-model-gateway` | Start and stop a local model gateway with Graphiti; disable to use an existing gateway. (env: MANAGE_MODEL_GATEWAY) |

<!-- cli-reference:end -->
