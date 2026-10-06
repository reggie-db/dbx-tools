# @dbx-tools/cli-lakebase-proxy

Connect PostgreSQL tools and local applications to Databricks Lakebase through
a stable loopback address. The proxy discovers the requested Lakebase resource,
uses your selected Databricks profile, and creates short-lived database
credentials without putting a Lakebase password in local configuration.

Use it when a client expects a normal PostgreSQL URL but cannot perform
Databricks discovery or credential exchange itself.

## Quick Start

Choose a configured Databricks profile and start the proxy:

```sh
dbx lakebase-proxy --profile PROFILE --port 5432
```

In another terminal, generate a client URL and connect:

```sh
psql "$(dbx lakebase-proxy url --target projects/my-project)"
```

The URL uses `localhost:5432`, stores the Lakebase target in the database path,
and sets `sslmode=disable` for the local hop. The proxy always uses verified TLS
for the connection to Lakebase.

## Choose A Lakebase Target

`--target` accepts the forms developers commonly have available:

| Target            | Example                                                     |
| ----------------- | ----------------------------------------------------------- |
| Project ID        | `my-project`                                                |
| Project resource  | `projects/my-project`                                       |
| Branch resource   | `projects/my-project/branches/production`                   |
| Endpoint resource | `projects/my-project/branches/production/endpoints/primary` |
| Database resource | `projects/my-project/branches/production/databases/app`     |
| Endpoint hostname | `ep-example.database.cloud.databricks.com`                  |
| PostgreSQL URL    | `postgresql://host/database`                                |

Set `LAKEBASE_ENDPOINT` when the same target should be the default:

```sh
export LAKEBASE_ENDPOINT=projects/my-project
export DATABASE_URL="$(dbx lakebase-proxy url)"
```

## Run As A Service

Install the proxy as a current-user tray service when local applications need
the endpoint to remain available across terminal sessions:

```sh
dbx lakebase-proxy service install --port 5432 --profile PROFILE
dbx lakebase-proxy service status
dbx lakebase-proxy service restart
dbx lakebase-proxy service uninstall
```

`service status` prints installation and process state as JSON. The installed
service remembers the selected port, startup timeout, and profile.

`service restart` relaunches the installed executable. Re-run `service install`
after upgrading the CLI to rebuild it and update the saved configuration.

## Connection Behavior

The listener defaults to `127.0.0.1:5432` and rejects non-loopback addresses.
Select `--profile` explicitly for predictable workspace access. If the proxy is
started without one, a PostgreSQL startup user is treated as a profile only when
it exactly matches a configured Databricks profile.

The proxy preserves startup parameters other than the resolved `user` and
`database`. Query cancellation, connection errors, and PostgreSQL startup
failures are returned to the local client using normal PostgreSQL behavior.

## Package API

- `cli` builds the foreground, URL, and service commands.
- `proxy` exposes `LakebaseProxy` for embedding the loopback listener.
- `protocol` exposes the PostgreSQL startup helpers used by the proxy.
- `cancellation` exposes cancellation-key coordination for embedded runtimes.

<!-- cli-reference:start -->

## Command Reference

### `dbx lakebase-proxy`

```text
Usage: dbx lakebase-proxy [options] [command]

Run a loopback PostgreSQL proxy for Databricks Lakebase

Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile

Commands:
  url [options]                        Format a local PostgreSQL URL for a Lakebase target
  service                              Install and manage the desktop service
```

### `dbx lakebase-proxy url`

```text
Usage: dbx lakebase-proxy url [options]

Format a local PostgreSQL URL for a Lakebase target

Options:
  --target <target>                    Lakebase project, resource path, host, or URL
  --endpoint <endpoint>                fallback target
  --host <host>                        local proxy host (default: "localhost")
  --port <port>                        local proxy port (default: 5432)

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service`

```text
Usage: dbx lakebase-proxy service [command]

Install and manage the desktop service

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile

Commands:
  install [options]                    Install the service for the current user and start it
  start                                Start the installed service
  stop                                 Stop the running service
  restart                              Restart the installed service
  status                               Print service installation and process state as JSON
  uninstall                            Stop and remove the service for the current user
```

### `dbx lakebase-proxy service install`

```text
Usage: dbx lakebase-proxy service install [options]

Install the service for the current user and start it

Options:
  --no-start                           install without starting the service
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service start`

```text
Usage: dbx lakebase-proxy service start

Start the installed service

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service stop`

```text
Usage: dbx lakebase-proxy service stop

Stop the running service

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service restart`

```text
Usage: dbx lakebase-proxy service restart

Restart the installed service

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service status`

```text
Usage: dbx lakebase-proxy service status

Print service installation and process state as JSON

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

### `dbx lakebase-proxy service uninstall`

```text
Usage: dbx lakebase-proxy service uninstall

Stop and remove the service for the current user

Global Options:
  -V, --version                        output the version number
  --host <host>                        loopback listener host (default: "127.0.0.1")
  --port <port>                        listener port (default: 5432)
  --startup-timeout-seconds <seconds>  startup timeout (default: 30)
  --profile <profile>                  exact Databricks profile
```

<!-- cli-reference:end -->
