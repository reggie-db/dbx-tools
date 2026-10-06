# @dbx-tools/cli-graphiti

Give agents persistent graph memory by running Graphiti with local Neo4j and
Databricks-hosted models. Start the stack in a terminal for development, or
install it as a desktop service that runs independently of your terminal.

## Start Graphiti

You need Bun, Python 3.11 or newer with pip, and a Databricks profile that can
access your chosen models:

```sh
bun add --global @dbx-tools/cli-graphiti
dbx-graphiti --python python3 --profile MY-PROFILE
```

The launcher installs the matching `dbx-tools-graphiti` Python package when
needed. The first start also prepares Neo4j and the Graphiti environment; later
starts reuse them. Keep the terminal open while the foreground stack runs.

If you already use the [`dbx` CLI](../dbx-tools), run the same stack with:

```sh
dbx graphiti --profile MY-PROFILE
```

The Graphiti MCP endpoint is `http://127.0.0.1:8000/mcp/` by default. See the
[Python runtime guide](../../../py/graphiti) for persistence and connection setup.

## Choose Models

Pass Graphiti's model options through the launcher:

```sh
dbx graphiti --profile MY-PROFILE --model databricks-gpt-5
dbx graphiti --profile MY-PROFILE --embedder-model databricks-gte-large-en --embedder-dimensions 1024
```

To reuse an existing model gateway instead of starting another one:

```sh
dbx graphiti --model-gateway-url http://127.0.0.1:4000/v1 --no-manage-model-gateway
```

The generated reference includes both launcher options and the Python options
it forwards.

## Run As A Desktop Service

```sh
dbx graphiti service install --python /absolute/path/to/python3 --profile MY-PROFILE
dbx graphiti service status
dbx graphiti service stop
dbx graphiti service start
dbx graphiti service uninstall
```

Installation starts the service and saves its Python executable and Databricks
profile. Use an absolute Python path if Python is available only in your shell
or virtual environment. `status` prints installation and process state as JSON.

`service restart` relaunches the installed runtime. Re-run `service install`
after upgrading the package to update that runtime. Model overrides in the
foreground examples are not service-install options.

## Embed The Launcher

Applications that manage their own process lifecycle can reuse the runtime
helpers without installing a desktop service:

```ts
import { ensureGraphitiPython, ensureGraphitiModelGateway } from "@dbx-tools/cli-graphiti/runtime";

await ensureGraphitiPython("python3");
const command = ensureGraphitiModelGateway();
```

AppKit applications should use
[`@dbx-tools/appkit-graphiti`](../../node/appkit-graphiti) for app-scoped memory
tools and sidecar lifecycle.

<!-- cli-reference:start -->

## Command Reference

### `dbx graphiti`

Run Graphiti or manage its current-user desktop service

```sh
dbx graphiti [options] [command] [args...]
```

#### Arguments

| Argument | Description                                              |
| -------- | -------------------------------------------------------- |
| `args`   | arguments forwarded to the Python Graphiti start command |

#### Options

| Option                | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `-v, --version`       | output the version number                                                |
| `--python <python>`   | Python executable used to run Graphiti (default: "python3", env: PYTHON) |
| `--profile <profile>` | Databricks profile used for model requests                               |

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

### Forwarded Graphiti Options

#### `dbx graphiti [ARGS]`

Start Neo4j, the model gateway, and Graphiti.

```sh
dbx graphiti [ARGS]
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
