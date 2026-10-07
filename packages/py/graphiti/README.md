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

async with GraphitiRuntime.from_options(
    {
        "profile": "MY-PROFILE",
    }
) as runtime:
    graphiti = runtime.graphiti
```

When `databaseUrl` is omitted, the runtime starts bundled PostgreSQL with
pgvector and persists it under `graphitiHome`, or the platform data directory
when no home is configured. The owned PostgreSQL process stops with the
runtime, while its data remains for the next start.

Pass a regular PostgreSQL URL to use an existing database. A passwordless
non-local URL, Lakebase resource path, or Lakebase project name is resolved by
the generated Node Lakebase client. It injects a fresh short-lived credential
whenever the asyncpg pool opens a physical connection, without persisting that
credential in the URL.

## Composition Boundary

`dbx_tools.graphiti.main` adds FastAPI REST and MCP surfaces around the same
importable runtime. Shared environment options are parsed through generated
PythonMonkey bindings and mapped into both upstream settings objects.
