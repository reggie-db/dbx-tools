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
