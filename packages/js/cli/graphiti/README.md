# @dbx-tools/cli-graphiti

Run Graphiti graph memory against Databricks-hosted chat and embedding models.
The launcher owns durable embedded FalkorDB, the optional model-gateway
process, the pinned Python Graphiti MCP adapter, and desktop-service lifecycle.

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
stack with `Ctrl-C`. Use the shared `service` commands for detached lifecycle.

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

FalkorDB writes the active graph to a local RDB under the configured Graphiti
home directory. Snapshot creation is change-aware and uses the same durable
runtime as `@dbx-tools/falkor-db`:

```sh
dbx graphiti \
  --profile MY-PROFILE \
  --falkor-data-dir ~/.local/share/my-agent-memory \
  --falkor-snapshot-seconds 60
```

The launcher restores the local RDB before Graphiti starts and closes FalkorDB
with `SHUTDOWN NOSAVE` after its change-aware persistence policy has completed.
Use a separate data directory for each logical graph.

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

| Option                                  | Description                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `-v, --version`                         | output the version number                                                                                                 |
| `--python <value>`                      | Python executable used to run the matching Graphiti package. (default: "python3", env: PYTHON)                            |
| `--profile <value>`                     | Databricks profile used for model discovery and authentication. (env: DATABRICKS_CONFIG_PROFILE)                          |
| `--graphiti-home <value>`               | Application-owned Graphiti runtime directory. (env: GRAPHITI_HOME)                                                        |
| `--model <value>`                       | Fuzzy chat-model name or endpoint identifier. (default: "databricks-gpt-5-nano", env: MODEL_NAME)                         |
| `--embedder-model <value>`              | Fuzzy embedding-model name or endpoint identifier. (default: "databricks-gte-large-en", env: EMBEDDER_MODEL)              |
| `--embedder-dimensions <value>`         | Embedding vector dimensions expected by Graphiti. (default: 1024, env: EMBEDDER_DIMENSIONS)                               |
| `--model-gateway-url <value>`           | Existing OpenAI-compatible model gateway base URL, including /v1. (env: MODEL_GATEWAY_URL)                                |
| `--model-gateway-host <value>`          | Listener host for a locally managed model gateway. (default: "127.0.0.1", env: MODEL_GATEWAY_HOST)                        |
| `--model-gateway-port <value>`          | Listener port for a locally managed model gateway. (default: 4400, env: MODEL_GATEWAY_PORT)                               |
| `--model-gateway-command <value>`       | Command used to start a locally managed model gateway. (env: MODEL_GATEWAY_COMMAND)                                       |
| `--manage-model-gateway`                | Whether Graphiti starts and stops a local model gateway. (env: MANAGE_MODEL_GATEWAY)                                      |
| `--no-manage-model-gateway`             | Disable whether graphiti starts and stops a local model gateway.                                                          |
| `--open-ai-api-key <value>`             | API key used only with an externally managed OpenAI-compatible endpoint. (env: OPENAI_API_KEY)                            |
| `--structured-output-mode <value>`      | Structured-output mode forwarded to Graphiti's OpenAI provider. (default: "json_object", env: LLM_STRUCTURED_OUTPUT_MODE) |
| `--graphiti-host <value>`               | Graphiti MCP listener host. (default: "127.0.0.1", env: GRAPHITI_HOST)                                                    |
| `--graphiti-port <value>`               | Graphiti MCP listener port. (default: 8000, env: GRAPHITI_PORT)                                                           |
| `--falkor-data-dir <value>`             | Local directory containing the active FalkorDB RDB. (env: FALKORDB_DATA_DIR)                                              |
| `--falkor-snapshot-seconds <value>`     | Seconds between change-aware FalkorDB snapshot checks. (default: 300, env: FALKOR_SNAPSHOT_SECONDS)                       |
| `--falkor-snapshot-min-changes <value>` | Minimum writes required before FalkorDB creates an RDB snapshot. (default: 1, env: FALKOR_SNAPSHOT_MIN_CHANGES)           |

#### Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `service` | Install and manage the desktop service |

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

| Option       | Description                                                       |
| ------------ | ----------------------------------------------------------------- |
| `--start`    | Start the service after installation. (default: true, env: START) |
| `--no-start` | Disable start the service after installation.                     |

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
