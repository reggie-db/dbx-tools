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
- starts `dbx-tools-litellm` and authenticates through a Databricks CLI profile;
- defaults to `databricks-gpt-5-nano` and the 1024-dimensional
  `databricks-gte-large-en` embedding model;
- provisions Java 21 and `uv` through `mise use -g` only when absent;
- pins Graphiti and Neo4j versions for repeatable local environments;
- caches downloads, Python dependencies, Neo4j data, credentials, and logs;
- needs no `config.yaml` and does not vendor Graphiti code.

## Quick start

`mise` and a working Databricks CLI profile must already be configured. The
launcher handles Java, `uv`, LiteLLM, Graphiti, and Neo4j:

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

For background operation:

```bash
uv run dbx-graphiti up
uv run dbx-graphiti status
uv run dbx-graphiti down
```

## Commands

- `setup` provisions tools and populates the local cache without starting
  services.
- `start` starts Neo4j and LiteLLM, then runs Graphiti in the foreground. This
  is the default.
- `up` starts all three services in the background.
- `down` stops the managed Graphiti, LiteLLM, and Neo4j processes.
- `status` prints process state, model selection, and the MCP URL as JSON.
- `env` prints resolved database, proxy, and model settings as JSON. Its output
  includes the Neo4j password and must be treated as secret.

Arguments after `--` are forwarded to upstream Graphiti:

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
6. A generated Neo4j password is stored with mode `0600`.
7. The packaged LiteLLM proxy starts against the selected Databricks profile,
   and Graphiti receives its OpenAI-compatible URL and model settings through
   environment variables and CLI flags.

The cache root is:

- macOS: `~/Library/Application Support/dbx-tools/graphiti`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/dbx-tools/graphiti`
- Windows: `%LOCALAPPDATA%/dbx-tools/graphiti`

Set `DBX_GRAPHITI_HOME` to override it. Removing the directory clears the
download cache and permanently removes the local graph data.

## Configuration

There is no Graphiti `config.yaml`. Model and server settings resolve from CLI
option, environment variable, then package default:

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
- `GRAPHITI_GROUP_ID`: defaults upstream to `main`.
- `GRAPHITI_HOST` and `GRAPHITI_PORT`: default upstream to `127.0.0.1` and
  `8000`.
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
lifecycle. See the
[upstream MCP server documentation](https://github.com/getzep/graphiti/tree/main/mcp_server)
for its complete API.
