# `dbx-tools-graphiti`

Run Graphiti REST, MCP, model routing, and PostgreSQL-backed graph memory from
one Python runtime. The build synchronizes the upstream REST and MCP source at
pinned commits. The PostGraph driver derived from Graphiti PR 1777 is maintained
as attributed package source, so the published wheel has no direct Git
dependencies.

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
bash scripts/run-graphiti-python.sh
```

The combined application exposes:

- FastAPI documentation at `/docs`
- OpenAPI at `/openapi.json`
- REST health and Graphiti routes, including `/healthcheck`, `/search`, and
  ingestion endpoints
- direct tool operations under `/tools/*`
- Streamable HTTP MCP at `/mcp/`

The MCP and direct HTTP operations use the same operation descriptions. The
OpenAPI document additionally carries per-argument descriptions extracted from
the operation `Args` sections into Pydantic fields; the upstream MCP schema does
not currently preserve that field-level detail. AppKit tool registration uses
the OpenAPI contract.

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
startup. It selects the chat endpoint by `modelClass`, which defaults to
`chat-fast`, and independently selects the best embedding-class endpoint. REST
and MCP reuse the same Graphiti model clients, while the auth client injects
refreshed Databricks headers into every model request.

Graphiti reads embedding dimensions from the discovered endpoint metadata
before initializing PostGraph. Startup fails clearly when the selected endpoint
does not publish a positive dimension; there is no model-name or dimension
fallback.

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
extra also preinstalls the locked PythonMonkey runtime so managed services do
not need a startup-time package download. The owned PostgreSQL process stops
with the runtime, while its data remains for the next start. Node, CLI, and
AppKit launchers select the extra automatically only when no external database
is configured.

Pass a regular PostgreSQL URL to use an existing database. A passwordless
non-local URL, Lakebase resource path, or Lakebase project name is resolved by
the generated Node Lakebase client. It injects a fresh short-lived credential
whenever the asyncpg pool opens a physical connection, without persisting that
credential in the URL. Lakebase mode provisions and uses the
`databaseSchema` schema, which defaults to `dbx_tools_graphiti`, because
application identities do not receive write access to `public`. Set
`GRAPHITI_DATABASE_SCHEMA` when multiple identities share one database. If the
database has no `vector` extension, Graphiti installs it in that schema. When
the database already has its single allowed `vector` installation, Graphiti
discovers that extension schema for type resolution without moving it.

## Memory Writes

The direct HTTP and MCP `add_memory` operation queues a write and returns
immediately. Call `wait_for_memory_queue` before stopping a short-lived runtime
when the caller needs queued work to be durable. Queue processing errors are
logged with their traceback and re-raised by the wait operation instead of
being reported as an empty successful queue.

Use `add_memory_sync` when the request itself must wait for persistence. Both
forms remain available; queued writes are not forced to become synchronous.
`get_queue_status` reports the pending count and worker state.

When creating an episode, omit `uuid` and use the generated episode UUID from
subsequent retrieval. A supplied `uuid` selects an existing episode to update.

## Composition Boundary

`dbx_tools.graphiti.main` adds FastAPI REST and MCP surfaces around the same
importable runtime. Shared environment options are parsed through generated
PythonMonkey bindings and mapped into both upstream settings objects.

The PostgreSQL graph driver is maintained under
`dbx_tools.graphiti.postgraph`. It is derived from the Apache-2.0 PostGraph
driver and carries upstream attribution beside the source. Run
`bun run graphiti:smoke:embedded` to exercise driver CRUD, full-text search,
and embedded PostgreSQL restart persistence outside the regular test suite.
