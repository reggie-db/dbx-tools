# @dbx-tools/cli-graphiti

Run Graphiti graph memory against Databricks-hosted chat and embedding models.
The launcher owns the local Neo4j runtime, model-gateway process, Graphiti
process, and optional desktop-service lifecycle.

## Install

Install the CLI with Bun:

```sh
bun add --global @dbx-tools/cli-graphiti
```

Graphiti requires Python 3.11 or newer and a Databricks profile that can access
the selected model endpoints. The launcher prepares the matching Python runtime
and pinned Graphiti dependencies on first use.

## Start Graphiti

Run the stack in the foreground:

```sh
dbx-graphiti --profile MY-PROFILE
```

The equivalent command through the combined dbx-tools CLI is:

```sh
dbx graphiti --profile MY-PROFILE
```

The default MCP endpoint is `http://127.0.0.1:8000/mcp/`. Stop the foreground
stack with `Ctrl-C`, or use `up`, `status`, and `down` for a detached local
runtime:

```sh
dbx graphiti up --profile MY-PROFILE
dbx graphiti status
dbx graphiti down
```

## Choose Models

Model names are fuzzy matched against the selected workspace's serving
endpoints. Configure chat and embedding models independently:

```sh
dbx graphiti \
  --profile MY-PROFILE \
  --model databricks-gpt-5 \
  --embedder-model databricks-gte-large-en
```

By default, the launcher starts a private model gateway for Graphiti. To use an
existing OpenAI-compatible gateway instead:

```sh
dbx graphiti \
  --model-gateway-url http://127.0.0.1:4000/v1 \
  --no-manage-model-gateway
```

Use `--openai-api-key` when the external gateway requires one.

## Persist Graph Writes

Neo4j data lives under the configured Graphiti home directory. For durable
recovery across lost local disks, configure the PostgreSQL write journal with a
Databricks profile or an explicit database URL:

```sh
dbx graphiti \
  --profile MY-PROFILE \
  --journal-namespace my-agent-memory
```

The journal records mutations before they reach the local graph and replays
them in order when Graphiti starts. Use a distinct namespace for each logical
graph. The journal is append-only; retention and full-snapshot policy remain an
operator responsibility.

## Install A Desktop Service

Install the same runtime as a current-user service:

```sh
dbx graphiti service install --profile MY-PROFILE
dbx graphiti service status
```

Use `start`, `stop`, `restart`, and `uninstall` to manage the installed service.
Re-run `service install` after upgrading the package so the compiled runtime is
updated.

## Use With AppKit

AppKit applications should use
[`@dbx-tools/appkit-graphiti`](../../node/appkit-graphiti). It reuses this
package's runtime and shared configuration while supervising sidecars inside
the application lifecycle.

The complete command and option reference below is generated directly from the
Commander parser. Built-in help flags are intentionally omitted.

<!-- cli-reference:start -->

## Command Reference

### `dbx graphiti`

Run Graphiti or manage its current-user desktop service

```sh
dbx graphiti [options] [command] [args...]
```

#### Arguments

| Argument | Description                                           |
| -------- | ----------------------------------------------------- |
| `args`   | arguments forwarded to the pinned Graphiti MCP server |

#### Options

| Option                               | Description                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `-v, --version`                      | output the version number                                                                        |
| `--python <python>`                  | Python executable used to run Graphiti (default: "python3", env: PYTHON)                         |
| `--profile <profile>`                | Databricks profile used for models and persistence (env: DATABRICKS_CONFIG_PROFILE)              |
| `--home <directory>`                 | Graphiti runtime and data directory (env: DBX_GRAPHITI_HOME)                                     |
| `--model <model>`                    | Fuzzy chat-model name or endpoint (default: "databricks-gpt-5-nano", env: MODEL_NAME)            |
| `--embedder-model <model>`           | Fuzzy embedding-model name or endpoint (default: "databricks-gte-large-en", env: EMBEDDER_MODEL) |
| `--embedder-dimensions <dimensions>` | Embedding vector dimensions (default: 1024, env: EMBEDDER_DIMENSIONS)                            |
| `--model-gateway-url <url>`          | Existing OpenAI-compatible gateway URL including /v1 (env: MODEL_GATEWAY_URL)                    |
| `--model-gateway-host <host>`        | Managed model-gateway listener host (default: "127.0.0.1", env: MODEL_GATEWAY_HOST)              |
| `--model-gateway-port <port>`        | Managed model-gateway listener port (default: 4400, env: MODEL_GATEWAY_PORT)                     |
| `--model-gateway-command <command>`  | Command used to start the managed model gateway (env: MODEL_GATEWAY_COMMAND)                     |
| `--manage-model-gateway`             | Start and stop a local model gateway (env: MANAGE_MODEL_GATEWAY)                                 |
| `--no-manage-model-gateway`          | Use an existing model gateway                                                                    |
| `--openai-api-key <key>`             | API key for an external OpenAI-compatible gateway (env: OPENAI_API_KEY)                          |
| `--structured-output-mode <mode>`    | Graphiti OpenAI structured-output mode (default: "json_object", env: LLM_STRUCTURED_OUTPUT_MODE) |
| `--graphiti-host <host>`             | Graphiti MCP listener host (default: "127.0.0.1", env: GRAPHITI_HOST)                            |
| `--graphiti-port <port>`             | Graphiti MCP listener port (default: 8000, env: GRAPHITI_PORT)                                   |
| `--proxy-port <port>`                | AppKit reverse-proxy listener port (default: 0, env: PROXY_PORT)                                 |
| `--journal-namespace <namespace>`    | Graphiti write-journal namespace (env: JOURNAL_NAMESPACE)                                        |
| `--journal-database-url <url>`       | Explicit PostgreSQL write-journal URL (env: JOURNAL_DATABASE_URL)                                |
| `--journal-table <table>`            | PostgreSQL write-journal table (env: JOURNAL_TABLE)                                              |

#### Commands

| Command           | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `start [args...]` | Start Neo4j, the model gateway, and Graphiti in the foreground |
| `up [args...]`    | Start Neo4j, the model gateway, and Graphiti in the background |
| `down`            | Stop Graphiti, the model gateway, and Neo4j                    |
| `status`          | Show native process and endpoint status                        |
| `env`             | Print resolved runtime and connection settings                 |
| `service`         | Install and manage the desktop service                         |

### `dbx graphiti start`

Start Neo4j, the model gateway, and Graphiti in the foreground

```sh
dbx graphiti start [args...]
```

#### Arguments

| Argument | Description                                           |
| -------- | ----------------------------------------------------- |
| `args`   | arguments forwarded to the pinned Graphiti MCP server |

### `dbx graphiti up`

Start Neo4j, the model gateway, and Graphiti in the background

```sh
dbx graphiti up [args...]
```

#### Arguments

| Argument | Description                                           |
| -------- | ----------------------------------------------------- |
| `args`   | arguments forwarded to the pinned Graphiti MCP server |

### `dbx graphiti down`

Stop Graphiti, the model gateway, and Neo4j

```sh
dbx graphiti down
```

### `dbx graphiti status`

Show native process and endpoint status

```sh
dbx graphiti status
```

### `dbx graphiti env`

Print resolved runtime and connection settings

```sh
dbx graphiti env
```

### `dbx graphiti service`

Install and manage the desktop service

```sh
dbx graphiti service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx graphiti service install`

Install the service for the current user and start it

```sh
dbx graphiti service install [options]
```

#### Options

| Option       | Description                          |
| ------------ | ------------------------------------ |
| `--no-start` | install without starting the service |

### `dbx graphiti service start`

Start the installed service

```sh
dbx graphiti service start
```

### `dbx graphiti service stop`

Stop the running service

```sh
dbx graphiti service stop
```

### `dbx graphiti service restart`

Restart the installed service

```sh
dbx graphiti service restart
```

### `dbx graphiti service status`

Print service installation and process state as JSON

```sh
dbx graphiti service status
```

### `dbx graphiti service uninstall`

Stop and remove the service for the current user

```sh
dbx graphiti service uninstall
```

<!-- cli-reference:end -->
