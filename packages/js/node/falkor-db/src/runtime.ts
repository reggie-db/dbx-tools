/**
 * Typed FalkorDB option application.
 *
 * @module
 */

import { workspaceClient } from "@dbx-tools/databricks";
import { DatabricksFileSystem } from "@dbx-tools/databricks/databricks-fs";
import { DurableFalkorDB } from "./falkor.ts";
import type { FalkorDBOptions } from "./options.ts";
import { DatabricksVolumeStorage } from "./persistence/volume.ts";

/** Open durable FalkorDB with every field from the owning option schema applied. */
export async function openFalkorDB(options: FalkorDBOptions): Promise<DurableFalkorDB> {
  const storage = options.volume ? await volumeStorage(options.volume, options.profile) : undefined;
  return DurableFalkorDB.open({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.listen?.scheme === "unix" ? { socketPath: options.listen.path } : {}),
    ...(options.listen?.scheme === "tcp"
      ? {
          port: options.listen.port,
          redisConfig: { bind: options.listen.host },
        }
      : {}),
    snapshotSeconds: options.snapshotSeconds,
    snapshotMinChanges: options.snapshotMinChanges,
    ...(storage ? { storage } : {}),
    ...(options.redisServerPath ? { redisServerPath: options.redisServerPath } : {}),
    ...(options.modulePath ? { modulePath: options.modulePath } : {}),
    ...(options.maxMemory ? { maxMemory: options.maxMemory } : {}),
    ...(options.redisLogLevel ? { logLevel: options.redisLogLevel } : {}),
    ...(options.redisLogFile ? { logFile: options.redisLogFile } : {}),
    timeout: options.startupTimeoutSeconds * 1000,
    inheritStdio: options.inheritStdio,
    handleSignals: false,
    persistence: {
      pollIntervalMs: options.backupPollSeconds * 1000,
      retention: options.retention,
      forceBackupOnShutdown: options.forceBackupOnShutdown,
      shutdownTimeoutMs: options.shutdownTimeoutSeconds * 1000,
      ...(options.staleBackupWarningSeconds === undefined
        ? {}
        : { staleBackupWarningMs: options.staleBackupWarningSeconds * 1000 }),
    },
  });
}

async function volumeStorage(root: string, profile?: string): Promise<DatabricksVolumeStorage> {
  const client = workspaceClient.toLegacyWorkspaceClient(
    await workspaceClient.createWorkspaceClient({ ...(profile ? { profile } : {}) }),
  );
  return new DatabricksVolumeStorage(new DatabricksFileSystem({ root, client, createRoot: true }));
}
