# `@dbx-tools/cli-falkor-db`

Run an embedded FalkorDB database in the foreground with its active graph on
local disk. Redis creates RDB snapshots only after configured writes, and the
CLI can stream completed snapshots to a Databricks Unity Catalog Volume.

## Start A Local Database

```sh
dbx falkor-db --data-dir /tmp/my-app/falkordb
```

The standalone `dbx-falkor-db` executable accepts the same options. FalkorDB
uses a private Unix socket and does not expose a TCP Redis port. Keep the command
running for as long as the application needs the database.

Without `--volume`, `dump.rdb` remains in the local data directory and completed
snapshot activity is logged. This is useful for local development and for
verifying persistence behavior before durable storage is configured.

## Back Up To A Databricks Volume

```sh
dbx falkor-db \
  --data-dir /tmp/my-app/falkordb \
  --volume /Volumes/main/app_data/state/falkordb \
  --profile WORKSPACE \
  --snapshot-seconds 300 \
  --snapshot-min-changes 1 \
  --retention 5
```

The selected profile is used only for Volume access. On startup the CLI restores
and verifies `latest.json` before starting FalkorDB. During operation it uploads
immutable snapshots first, then advances the manifest. Upload failures are
logged while the local graph continues running.

## Shutdown Behavior

SIGINT and SIGTERM close FalkorDB with `SHUTDOWN NOSAVE`; shutdown does not force
an additional RDB by default. Opt in when the termination budget should be used
to save dirty data and upload it before exit:

```sh
dbx falkor-db \
  --volume /Volumes/main/app_data/state/falkordb \
  --profile WORKSPACE \
  --force-backup-on-shutdown \
  --shutdown-timeout-seconds 30
```

The CLI intentionally has no service command. Run it under the application or
container lifecycle that owns the graph.

<!-- cli-reference:start -->

## Command Reference

### `dbx falkor-db`

Run embedded FalkorDB with change-aware local and durable snapshots

```sh
dbx falkor-db [options]
```

#### Options

| Option                                     | Description                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `-v, --version`                            | output the version number                                                                 |
| `--data-dir <path>`                        | active local FalkorDB directory (env: FALKORDB_DATA_DIR)                                  |
| `--snapshot-seconds <seconds>`             | Redis snapshot interval (default: 300, env: FALKORDB_SNAPSHOT_SECONDS)                    |
| `--snapshot-min-changes <count>`           | writes required before an interval saves (default: 1, env: FALKORDB_SNAPSHOT_MIN_CHANGES) |
| `--volume <path>`                          | durable Unity Catalog Volume directory (env: FALKORDB_VOLUME)                             |
| `--profile <name>`                         | exact Databricks profile used for Volume access (env: DATABRICKS_CONFIG_PROFILE)          |
| `--retention <count>`                      | durable snapshots retained (default: 5)                                                   |
| `--backup-poll-seconds <seconds>`          | completed-RDB polling interval (default: 10)                                              |
| `--stale-backup-warning-seconds <seconds>` | warn when changed data lacks a recent durable backup                                      |
| `--force-backup-on-shutdown`               | force a dirty RDB and durable upload before shutdown                                      |
| `--shutdown-timeout-seconds <seconds>`     | shutdown backup timeout (default: 30)                                                     |
| `--redis-server-path <path>`               | custom redis-server executable                                                            |
| `--module-path <path>`                     | custom FalkorDB module                                                                    |
| `--max-memory <limit>`                     | Redis memory limit such as 256mb                                                          |
| `--redis-log-level <level>`                | Redis log level (choices: "debug", "verbose", "notice", "warning")                        |
| `--redis-log-file <path>`                  | Redis log file                                                                            |
| `--startup-timeout-seconds <seconds>`      | embedded server startup timeout (default: 10)                                             |
| `--inherit-stdio`                          | inherit redis-server stdout and stderr                                                    |

<!-- cli-reference:end -->
