# dbx-tools-graphiti

Run Graphiti REST, MCP, model routing, and PostgreSQL-backed graph memory from
one Python runtime. Use embedded PostgreSQL for local persistence or connect to
an external PostgreSQL or Lakebase database.

## Start the server

```bash
uv add 'dbx-tools-graphiti[dev]'
GRAPHITI_LISTEN=tcp://127.0.0.1:8000 \
uv run python -m dbx_tools.graphiti
```

The application exposes:

- FastAPI documentation at `/docs`.
- OpenAPI at `/openapi.json`.
- Health, search, and ingestion routes, including `/healthcheck` and `/search`.
- Direct tool operations under `/tools/*`.
- Streamable HTTP MCP at `/mcp/`.

The direct HTTP and MCP operations share the same operation definitions.
OpenAPI includes field-level argument descriptions for AppKit tool
registration.

From this repository, start the local runtime with an explicit configured
profile:

```bash
cd packages/py/graphiti
DATABRICKS_CONFIG_PROFILE=<profile> \
uv run --extra dev python -m dbx_tools.graphiti
```

## Print the OpenAPI document

Generate the OpenAPI JSON without starting PostgreSQL or model clients:

```bash
python -m dbx_tools.graphiti docs
```

The command writes the document to standard output and exits.

## Configure Graphiti

The Python server and Node supervisor use the same environment contract:

| Setting                                 | Default                        | Purpose                                                                     |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `DATABRICKS_CONFIG_PROFILE`             | Python SDK default credentials | Selects a Databricks CLI profile.                                           |
| `MODEL_CLASS`                           | `chat-fast`                    | Selects the chat model capability class.                                    |
| `TEMPERATURE`                           | `1`                            | Sets the Graphiti LLM sampling temperature from 0 through 2.                |
| `LLM_STRUCTURED_OUTPUT_MODE`            | `json_object`                  | Selects the structured-output mode passed to Graphiti.                      |
| `GRAPHITI_LISTEN`                       | `tcp://127.0.0.1:7272`         | Sets the HTTP listener.                                                     |
| `GRAPHITI_TOKEN`                        | Unset                          | Requires one bearer token for every Graphiti HTTP endpoint.                 |
| `GRAPHITI_HOME`                         | Platform data directory        | Sets the embedded runtime data directory.                                   |
| `DATABASE_URL` or `LAKEBASE_ENDPOINT`   | Unset                          | Selects external PostgreSQL or Lakebase. Omit both for embedded PostgreSQL. |
| `GRAPHITI_DATABASE_SCHEMA`              | `dbx_tools_graphiti`           | Selects the PostgreSQL schema for graph tables.                             |
| `DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS` | `180000`                       | Limits startup time for Node-supervised processes.                          |

PostgreSQL settings such as `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGSSLMODE` follow the shared dbx-tools Postgres option schema.

## Understand model selection

The process creates one auth client and one model client at startup. It selects
the chat endpoint by `modelClass` and independently selects the highest-ranked
embedding endpoint. REST and MCP reuse the same model clients. The auth client
adds refreshed Databricks headers to each model request.

Graphiti reads embedding dimensions from discovered endpoint metadata before it
initializes PostGraph. Startup fails when the selected endpoint doesn't publish
a positive dimension. There is no model-name or dimension fallback.

## Use Graphiti from Python

Use the importable runtime without starting Uvicorn:

```python
from dbx_tools.graphiti.runtime import GraphitiRuntime

async with GraphitiRuntime.from_options(
    {"profile": "MY-PROFILE", "modelClass": "chat-fast"}
) as runtime:
    graphiti = runtime.graphiti
```

In a Databricks notebook or Lakeflow Job, omitted auth options use the Python
SDK's default `WorkspaceClient`. Pass `profile` only when you need to select an
explicit Databricks CLI profile.

Graphiti depends on `dbx-tools-node-runtime`. A normal pip installation works
on Databricks serverless compute without system Node.js or npm:

```python
%pip install dbx-tools-graphiti
```

The shared runtime uses system npm when available. Otherwise, its first binding
load installs a compatible `nodejs-wheel` and PythonMonkey into the active
Python environment.

## Choose database persistence

Install the optional embedded runtime when you don't provide `databaseUrl`:

```bash
uv add 'dbx-tools-graphiti[dev]'
```

Embedded mode starts PostgreSQL with pgvector and persists data under
`GRAPHITI_HOME` or the platform data directory. The PostgreSQL process stops
with the runtime. Its data remains for the next start.

Pass a PostgreSQL URL to use an existing database. A passwordless non-local
URL, Lakebase resource path, or Lakebase project name is resolved by the
generated Lakebase client. It adds a short-lived credential when asyncpg opens
a physical connection without persisting that credential in the URL.

Lakebase mode uses `GRAPHITI_DATABASE_SCHEMA`, which defaults to
`dbx_tools_graphiti`, because application identities normally can't write to
`public`. If no `vector` extension exists, Graphiti installs it in that schema.
If the database has an existing `vector` installation, Graphiti uses that
extension schema for type resolution.

## Wait for memory writes

The direct HTTP and MCP `add_memory` operation queues a write and returns
immediately. Call `wait_for_memory_queue` before stopping a short-lived runtime
when queued work must be durable. Queue processing errors are logged with their
tracebacks and raised by the wait operation.

Use `add_memory_sync` when the request must wait for persistence.
`get_queue_status` reports the pending count and worker state.

When you create an episode, omit `uuid` and use the generated UUID for later
retrieval. A supplied `uuid` selects an existing episode to update.

## Understand operational limits

- Embedded PostgreSQL requires the `dev` extra. Without an external database
  or that extra, startup fails.
- External PostgreSQL must support the `vector` extension. The runtime installs
  it only when the connected identity has permission.
- Queued `add_memory` calls can outlive the request that submitted them. Use
  `add_memory_sync` or `wait_for_memory_queue` before shutdown when required.
- `GRAPHITI_TOKEN` is one shared HTTP bearer token. It doesn't replace
  Databricks model authentication or provide per-user authorization.
- Set `GRAPHITI_TOKEN` before you expose `GRAPHITI_LISTEN` on a non-loopback
  interface.
- Model and embedding discovery happens at startup. A model endpoint change
  requires a runtime restart before selection runs again.
