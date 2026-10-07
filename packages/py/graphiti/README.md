# `dbx-tools-graphiti`

Run Graphiti REST, MCP, model routing, and PostgreSQL-backed graph memory from
one Python runtime. The build synchronizes the upstream REST and MCP source plus
the pinned PostGraph driver from Graphiti PR 1777 into the generated package
tree, so the published wheel has no direct Git dependencies.

Both upstream surfaces come from the same Graphiti commit:

- `graph-service` from `server/`
- `mcp-server` from `mcp_server/`

## Run

```sh
GRAPHITI_LISTEN=tcp://0.0.0.0:8000 \
uv run python -m dbx_tools.graphiti
```

From the repository root, the local launcher starts the unified runtime:

```sh
DATABRICKS_CONFIG_PROFILE=<profile> \
MODEL_NAME=databricks-gpt-5-nano \
bash scripts/run-graphiti-python.sh
```

The combined application exposes:

- FastAPI documentation at `/docs`
- OpenAPI at `/openapi.json`
- REST health and Graphiti routes, including `/healthcheck`, `/search`, and
  ingestion endpoints
- direct tool operations under `/tools/*`
- Streamable HTTP MCP at `/mcp/`

Configure Graphiti through the shared environment contract used by the Node
runtime and CLI.

The package also provides an environment-configured server entry point and a
schema-only command:

```bash
python -m dbx_tools.graphiti
python -m dbx_tools.graphiti docs
```

`docs` writes the OpenAPI JSON document to stdout and exits without starting the
database runtime.

## Databricks Model Resolution

The process creates one generated auth client and one generated model client at
startup. It resolves the fuzzy chat model, ranks embedding endpoints by the
configured name, embedding class, and dimensions, then resolves both endpoint
routes. REST and MCP reuse the same Graphiti model clients, while the auth client
injects refreshed Databricks headers into every model request.

## Use From A Notebook

Use the same resolved option names without starting Uvicorn:

```python
from dbx_tools.graphiti.runtime import GraphitiRuntime

async with GraphitiRuntime.from_options() as runtime:
    graphiti = runtime.graphiti
```

In a Databricks notebook or Job, omitted auth options use the Python SDK's
default `WorkspaceClient`. Graphiti receives the runtime host and refreshed
authentication headers without copying credentials into environment variables.
Pass `profile` only when selecting an explicit profile instead.

The base package is suitable for Lakebase, external PostgreSQL, Spark
notebooks, and serverless notebook Jobs:

```bash
uv add dbx-tools-graphiti
```

Graphiti depends on `dbx-tools-node-runtime`. A normal pip installation is
sufficient on Databricks serverless compute even when Node.js and npm are not
installed:

```python
%pip install dbx-tools-graphiti
```

The shared runtime reuses system npm when available. Otherwise its first binding
load installs a compatible `nodejs-wheel`, creates direct build launchers, and
installs PythonMonkey into the active Python environment. Generated Graphiti
bindings import that runtime instead of carrying their own PythonMonkey loader
or Node shim copies.

For Python callers that omit `databaseUrl`, install the optional embedded
runtime:

```bash
uv add 'dbx-tools-graphiti[dev]'
```

Embedded mode starts bundled PostgreSQL with pgvector and persists it under
`graphitiHome`, or the platform data directory when no home is configured. The
owned PostgreSQL process stops with the runtime, while its data remains for the
next start. Node, CLI, and AppKit launchers select the extra automatically only
when no external database is configured.

Pass a regular PostgreSQL URL to use an existing database. A passwordless
non-local URL, Lakebase resource path, or Lakebase project name is resolved by
the generated Node Lakebase client. It injects a fresh short-lived credential
whenever the asyncpg pool opens a physical connection, without persisting that
credential in the URL.

## Memory Writes

`add_memory` queues a write and returns immediately. Call
`wait_for_memory_queue` before stopping a short-lived runtime when the caller
needs queued work to be durable. Queue processing errors are re-raised by the
wait operation instead of being reported as an empty successful queue.

Use `add_memory_sync` when the request itself must wait for persistence. Both
forms remain available; queued writes are not forced to become synchronous.
`get_queue_status` reports the pending count and worker state.

When creating an episode, omit `uuid` and use the generated episode UUID from
subsequent retrieval. A supplied `uuid` selects an existing episode to update.

## Composition Boundary

`dbx_tools.graphiti.main` adds FastAPI REST and MCP surfaces around the same
importable runtime. Shared environment options are parsed through generated
PythonMonkey bindings and mapped into both upstream settings objects.
