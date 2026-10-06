# @dbx-tools/cli-graphiti

Run Graphiti graph memory against Databricks-hosted chat and embedding models.
The CLI layers foreground execution and desktop-service commands on the
`@dbx-tools/graphiti` Node runtime, which owns model discovery, authentication,
durable embedded FalkorDB, and process supervision.

## Install

Install the CLI with Bun:

```sh
bun add --global @dbx-tools/cli-graphiti
```

Graphiti requires uv and a Databricks profile that can access the selected model
endpoints. Desktop service installation manages its isolated runtime
automatically.

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

The runtime resolves the selected routes and refreshes Databricks headers for
model requests.

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
The shared service installer lets uv provision the matching runtime beside the
compiled Node service. Re-run `service install` after upgrading the package.
uv must be available on `PATH` during installation.

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
dbx graphiti [options] [command]
```

#### Options

| Option                                  | Description                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `-v, --version`                         | output the version number                                                                                                 |
| `--profile <value>`                     | Databricks profile used for model discovery and authentication. (env: DATABRICKS_CONFIG_PROFILE)                          |
| `--graphiti-home <value>`               | Application-owned Graphiti runtime directory. (env: GRAPHITI_HOME)                                                        |
| `--model <value>`                       | Fuzzy chat-model name or endpoint identifier. (default: "databricks-gpt-5-nano", env: MODEL_NAME)                         |
| `--temperature <value>`                 | Sampling temperature forwarded to the Graphiti LLM client. (default: 1, env: TEMPERATURE)                                 |
| `--embedder-model <value>`              | Fuzzy embedding-model name or endpoint identifier. (default: "gte-large-en", env: EMBEDDER_MODEL)                         |
| `--embedder-dimensions <value>`         | Embedding vector dimensions expected by Graphiti. (default: 1024, env: EMBEDDER_DIMENSIONS)                               |
| `--structured-output-mode <value>`      | Structured-output mode forwarded to Graphiti's OpenAI provider. (default: "json_object", env: LLM_STRUCTURED_OUTPUT_MODE) |
| `--listen <value>`                      | Graphiti HTTP listener. (default: tcp://127.0.0.1:7272, env: GRAPHITI_LISTEN)                                             |
| `--falkor-data-dir <value>`             | Active local FalkorDB directory. (env: FALKORDB_DATA_DIR)                                                                 |
| `--falkor-listen <value>`               | FalkorDB listener used by Graphiti. (default: tcp://127.0.0.1:6379, env: FALKORDB_LISTEN)                                 |
| `--falkor-database <value>`             | Default graph name for consumers. (default: "default_db", env: FALKORDB_DATABASE)                                         |
| `--falkor-snapshot-seconds <value>`     | Redis snapshot interval in seconds. (default: 300, env: FALKORDB_SNAPSHOT_SECONDS)                                        |
| `--falkor-snapshot-min-changes <value>` | Writes required before an interval saves. (default: 1, env: FALKORDB_SNAPSHOT_MIN_CHANGES)                                |

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

| Option       | Description                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `--start`    | Start the service after installation. (default: true, env: DBX_TOOLS_START) |
| `--no-start` | Disable start the service after installation.                               |

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
