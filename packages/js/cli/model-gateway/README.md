# @dbx-tools/cli-model-gateway

Expose Databricks-hosted models on a local OpenAI-compatible endpoint for Codex,
SDKs, and development tools. The CLI discovers models from the selected
workspace and can run temporarily in a terminal or continuously as a
current-user service.

## Quick Start

```sh
dbx model-gateway --profile PROFILE --port 4000
```

Point an OpenAI-compatible client at `http://127.0.0.1:4000/v1`, then inspect
the models available to that client:

```sh
curl http://127.0.0.1:4000/v1/models
```

The standalone `dbx-model-gateway` executable accepts the same options.

## Run As A Service

Install the gateway when local tools need it outside an active terminal:

```sh
dbx model-gateway service install --port 4401 --profile PROFILE
dbx model-gateway service status
dbx model-gateway service restart
dbx model-gateway service uninstall
```

The installed service remembers the port and profile. Its tray menu opens the
active `/v1/models` response and provides a clean quit action. `service status`
prints installation and process state as JSON.

`service restart` relaunches the installed executable. Re-run `service install`
after upgrading the CLI to rebuild that executable and update its saved options.

## Connection Behavior

The gateway binds to loopback only; valid hosts are `127.0.0.1`, `::1`, and
`localhost`. Choose `--profile` explicitly when more than one Databricks profile
is configured. Use `--runtime-info` to print the implementation and package
version without starting the server.

The loopback server accepts JSON request bodies up to 100 MB so long-running
agent and Codex histories reach the selected model service instead of failing at
the local gateway. The client and upstream service still enforce their own
context and request limits.

For embedded AppKit use, protocol support, and request compatibility, see
[`@dbx-tools/appkit-model-gateway`](../../node/appkit-model-gateway). Browser-safe
model discovery lives in
[`@dbx-tools/shared-model-gateway`](../../shared/model-gateway).

<!-- cli-reference:start -->

## Command Reference

### `dbx model-gateway`

```text
Usage: dbx model-gateway [options] [command]

Run or manage the AppKit Databricks model gateway

Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number

Commands:
  service              Install and manage the desktop service
```

### `dbx model-gateway service`

```text
Usage: dbx model-gateway service [command]

Install and manage the desktop service

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number

Commands:
  install [options]    Install the service for the current user and start it
  start                Start the installed service
  stop                 Stop the running service
  restart              Restart the installed service
  status               Print service installation and process state as JSON
  uninstall            Stop and remove the service for the current user
```

### `dbx model-gateway service install`

```text
Usage: dbx model-gateway service install [options]

Install the service for the current user and start it

Options:
  --no-start           install without starting the service

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

### `dbx model-gateway service start`

```text
Usage: dbx model-gateway service start

Start the installed service

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

### `dbx model-gateway service stop`

```text
Usage: dbx model-gateway service stop

Stop the running service

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

### `dbx model-gateway service restart`

```text
Usage: dbx model-gateway service restart

Restart the installed service

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

### `dbx model-gateway service status`

```text
Usage: dbx model-gateway service status

Print service installation and process state as JSON

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

### `dbx model-gateway service uninstall`

```text
Usage: dbx model-gateway service uninstall

Stop and remove the service for the current user

Global Options:
  --host <host>        loopback host to bind (default: "127.0.0.1")
  --port <port>        HTTP port (default: 4000)
  --profile <profile>  Databricks profile used for model discovery and requests
  --runtime-info       print runtime implementation metadata
  -v, --version        output the version number
```

<!-- cli-reference:end -->
