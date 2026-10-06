# `dbx-tools-graphiti`

Run Graphiti's REST and MCP applications together in one FastAPI process.
The package composes the upstream routers, service initialization, MCP tools,
and MCP session manager without copying their implementations.

Both upstream packages resolve from the same Graphiti commit:

- `graph-service` from `server/`
- `mcp-server` from `mcp_server/`

## Run

```sh
UVICORN_HOST=0.0.0.0 \
UVICORN_PORT=8000 \
uv run uvicorn dbx_tools.graphiti.main:app
```

From the repository root, the local launcher starts the FalkorDB CLI first,
waits for its loopback TCP listener, and then starts Uvicorn:

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
- Streamable HTTP MCP at `/mcp/`

Configure Graphiti through the environment and YAML settings supported by the
two upstream applications.

## Databricks Model Resolution

The process creates one generated auth client and one generated model client at
startup. It resolves the fuzzy chat model, ranks embedding endpoints by the
configured name, embedding class, and dimensions, then resolves both endpoint
routes. REST and MCP reuse the same Graphiti model clients, while the auth client
injects refreshed Databricks headers into every model request.

## Composition Boundary

`dbx_tools.graphiti.main` owns only the combined FastAPI lifespan and route
mounting. It initializes the upstream REST application through
`initialize_graphiti()`, initializes the existing MCP services without invoking
their CLI parser, and runs the mounted MCP session manager in the parent
lifespan. Shared Graphiti environment options are parsed through the generated
`graphiti_options_from_environment()` binding and mapped into both upstream
settings objects before initialization.
