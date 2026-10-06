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

| Option                                   | Description                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-v, --version`                          | output the version number                                                                                   |
| `--data-dir <value>`                     | Active local FalkorDB directory. (env: FALKORDB_DATA_DIR)                                                   |
| `--snapshot-seconds <value>`             | Redis snapshot interval in seconds. (default: 300, env: FALKORDB_SNAPSHOT_SECONDS)                          |
| `--snapshot-min-changes <value>`         | Writes required before an interval saves. (default: 1, env: FALKORDB_SNAPSHOT_MIN_CHANGES)                  |
| `--volume <value>`                       | Durable Unity Catalog Volume directory. (env: FALKORDB_VOLUME)                                              |
| `--profile <value>`                      | Exact Databricks profile used for Volume access. (env: DATABRICKS_CONFIG_PROFILE)                           |
| `--retention <value>`                    | Durable snapshots retained. (default: 5, env: RETENTION)                                                    |
| `--backup-poll-seconds <value>`          | Completed-RDB polling interval in seconds. (default: 10, env: BACKUP_POLL_SECONDS)                          |
| `--stale-backup-warning-seconds <value>` | Seconds before warning that changed data lacks a recent durable backup. (env: STALE_BACKUP_WARNING_SECONDS) |
| `--force-backup-on-shutdown`             | Force a dirty RDB and durable upload before shutdown. (default: false, env: FORCE_BACKUP_ON_SHUTDOWN)       |
| `--no-force-backup-on-shutdown`          | Disable force a dirty rdb and durable upload before shutdown.                                               |
| `--shutdown-timeout-seconds <value>`     | Shutdown backup timeout in seconds. (default: 30, env: SHUTDOWN_TIMEOUT_SECONDS)                            |
| `--redis-server-path <value>`            | Custom redis-server executable. (env: REDIS_SERVER_PATH)                                                    |
| `--module-path <value>`                  | Custom FalkorDB module. (env: MODULE_PATH)                                                                  |
| `--max-memory <value>`                   | Redis memory limit such as 256mb. (env: MAX_MEMORY)                                                         |
| `--redis-log-level <value>`              | Redis log level. (choices: "debug", "verbose", "notice", "warning", env: REDIS_LOG_LEVEL)                   |
| `--redis-log-file <value>`               | Redis log file. (env: REDIS_LOG_FILE)                                                                       |
| `--startup-timeout-seconds <value>`      | Embedded server startup timeout in seconds. (default: 10, env: STARTUP_TIMEOUT_SECONDS)                     |
| `--inherit-stdio`                        | Inherit redis-server stdout and stderr. (default: false, env: INHERIT_STDIO)                                |
| `--no-inherit-stdio`                     | Disable inherit redis-server stdout and stderr.                                                             |

<!-- cli-reference:end -->
