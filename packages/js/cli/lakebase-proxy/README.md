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
dbx lakebase-proxy --profile PROFILE --listen :5432
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
dbx lakebase-proxy service install --listen :5432 --profile PROFILE
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

Run a loopback PostgreSQL proxy for Databricks Lakebase

```sh
dbx lakebase-proxy [options] [command]
```

#### Options

| Option                              | Description                                                             |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `-V, --version`                     | output the version number                                               |
| `--listen <value>`                  | Loopback listener address. (default: localhost:5432, env: LISTEN)       |
| `--startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS) |
| `--profile <value>`                 | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)              |

#### Commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `url [options]` | Format a local PostgreSQL URL for a Lakebase target |
| `service`       | Install and manage the desktop service              |

### `dbx lakebase-proxy url`

Format a local PostgreSQL URL for a Lakebase target

```sh
dbx lakebase-proxy url [options]
```

#### Options

| Option             | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `--target <value>` | Lakebase project, resource path, host, or URL. (env: TARGET) |
| `--listen <value>` | Local proxy address. (default: localhost:5432, env: LISTEN)  |

### `dbx lakebase-proxy service`

Install and manage the desktop service

```sh
dbx lakebase-proxy service [command]
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

### `dbx lakebase-proxy service install`

Install the service for the current user and start it

```sh
dbx lakebase-proxy service install [options]
```

#### Options

| Option                              | Description                                                             |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `--start`                           | Start the service after installation. (default: true, env: START)       |
| `--no-start`                        | Disable start the service after installation.                           |
| `--listen <value>`                  | Loopback listener address. (default: localhost:5432, env: LISTEN)       |
| `--startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS) |
| `--profile <value>`                 | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)              |

### `dbx lakebase-proxy service start`

Start the installed service

```sh
dbx lakebase-proxy service start
```

### `dbx lakebase-proxy service stop`

Stop the running service

```sh
dbx lakebase-proxy service stop
```

### `dbx lakebase-proxy service restart`

Restart the installed service

```sh
dbx lakebase-proxy service restart
```

### `dbx lakebase-proxy service status`

Print service installation and process state as JSON

```sh
dbx lakebase-proxy service status
```

### `dbx lakebase-proxy service uninstall`

Stop and remove the service for the current user

```sh
dbx lakebase-proxy service uninstall
```

<!-- cli-reference:end -->
