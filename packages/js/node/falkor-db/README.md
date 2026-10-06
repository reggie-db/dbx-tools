# `@dbx-tools/falkor-db`

Run FalkorDB inside a Node.js or Bun process while keeping the active graph on
fast local disk. Redis creates RDB files only after configured graph changes;
the package detects completed saves and can copy them to durable storage such as
a Databricks Unity Catalog Volume.

The local database remains usable when no Volume is configured. In that mode
the package logs Redis persistence state and keeps `dump.rdb` under the local
data directory, but does not attempt remote backup or restore.

## Start A Local Graph

```ts
import { DurableFalkorDB } from "@dbx-tools/falkor-db";

const database = await DurableFalkorDB.open({
  dataDir: "/tmp/my-app/falkordb",
});

const graph = database.selectGraph("knowledge");
await graph.query("CREATE (:Person {name: $name})", { params: { name: "Ada" } });

await database.close();
```

FalkorDB listens only on its private Unix socket. No TCP Redis port is opened.
The bundled platform dependency provides Redis and the FalkorDB module for
macOS arm64 and Linux x64.

## Back Up To A Databricks Volume

Root the Databricks filesystem at the directory dedicated to this database.
Authentication stays with the caller-provided workspace client or AppKit
execution context.

```ts
import { DatabricksFileSystem } from "@dbx-tools/databricks/databricks-fs";
import { DatabricksVolumeStorage, DurableFalkorDB } from "@dbx-tools/falkor-db";

const volume = new DatabricksFileSystem({
  root: "/Volumes/main/app_data/state/falkordb",
  createRoot: true,
});

const database = await DurableFalkorDB.open({
  dataDir: "/tmp/my-app/falkordb",
  storage: new DatabricksVolumeStorage(volume),
  snapshotSeconds: 300,
  snapshotMinChanges: 1,
  persistence: {
    retention: 5,
    staleBackupWarningMs: 15 * 60_000,
  },
});
```

On startup, `latest.json` is read before FalkorDB starts. A referenced snapshot
is streamed to local disk, verified by SHA-256, and placed at `dump.rdb`. A
missing manifest means “use the local database”; a missing or corrupt referenced
snapshot fails startup rather than silently opening an empty graph.

Completed saves are uploaded in this order:

1. Copy the live `dump.rdb` to an immutable local staging file.
2. Calculate SHA-256 and stream `snapshots/00000001.rdb` without overwrite.
3. Replace `latest.json` only after the snapshot upload succeeds.
4. Retain the newest configured snapshots without deleting the manifest target.

If an upload fails, graph operations continue against local disk. Backup checks
retry with bounded backoff and coalesce multiple RDB completions so the newest
state eventually becomes durable without uploading every intermediate file.

## Configuration

| Option                              | Environment                     | Default                              | Purpose                                                   |
| ----------------------------------- | ------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `dataDir`                           | `FALKORDB_DATA_DIR`             | OS temp directory under the app name | Active local database directory                           |
| `snapshotSeconds`                   | `FALKORDB_SNAPSHOT_SECONDS`     | `300`                                | Seconds in Redis `save <seconds> <changes>`               |
| `snapshotMinChanges`                | `FALKORDB_SNAPSHOT_MIN_CHANGES` | `1`                                  | Minimum writes before the interval can produce an RDB     |
| `persistence.pollIntervalMs`        | —                               | `10000`                              | Completed-save observation interval                       |
| `persistence.retention`             | —                               | `5`                                  | Durable snapshots retained                                |
| `persistence.forceBackupOnShutdown` | —                               | `false`                              | Force a dirty `BGSAVE` and durable upload during shutdown |
| `persistence.shutdownTimeoutMs`     | —                               | `30000`                              | Maximum shutdown-backup wait                              |

Shutdown always terminates Redis with `SHUTDOWN NOSAVE`, preventing
FalkorDBLite’s persistent-mode close from writing an unconditional extra RDB.
Set `forceBackupOnShutdown: true` only when the container termination budget and
Volume availability justify forcing dirty state durable before that shutdown.

`persistenceStatus` exposes the latest Redis save fields, durable backup time,
sequence, size, duration, failure count, and restore metrics for health endpoints
or telemetry adapters.

## Storage Abstraction

`VolumeStorage` owns only durable file operations: existence, streaming upload
and download, JSON manifests, listing, and deletion. Implement it for another
backend without changing FalkorDB lifecycle or snapshot policy. Keep credentials
and provider-specific authentication inside the storage implementation.

## Operational Limits

- Supported bundled platforms are macOS arm64 and Linux x64. Other platforms
  must provide compatible `redisServerPath` and `modulePath` values.
- The active database must remain on local disk. Do not use `/Volumes/...` as
  `dataDir`.
- A Volume outage delays durability but does not block graph reads or writes.
- A referenced corrupt or unavailable snapshot blocks startup by design.
- One process should own a given local data directory at a time.
