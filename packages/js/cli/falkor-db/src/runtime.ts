/**
 * Foreground embedded FalkorDB process and optional Volume storage wiring.
 *
 * This module owns terminal signal handling and Databricks profile selection
 * for the CLI. Reuse {@link runFalkorDB} from CLI entry points instead of
 * duplicating process lifetime or Volume client construction.
 *
 * @module
 */

import { workspaceClient } from "@dbx-tools/databricks";
import { DatabricksFileSystem } from "@dbx-tools/databricks/databricks-fs";
import { DatabricksVolumeStorage, DurableFalkorDB } from "@dbx-tools/falkor-db";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("cli:falkor-db");

/** Foreground FalkorDB settings resolved by the owning Commander parser. */
export interface RunFalkorDBOptions {
  readonly dataDir?: string;
  readonly snapshotSeconds: number;
  readonly snapshotMinChanges: number;
  readonly volume?: string;
  readonly profile?: string;
  readonly retention: number;
  readonly backupPollSeconds: number;
  readonly staleBackupWarningSeconds?: number;
  readonly forceBackupOnShutdown?: boolean;
  readonly shutdownTimeoutSeconds: number;
  readonly redisServerPath?: string;
  readonly modulePath?: string;
  readonly maxMemory?: string;
  readonly redisLogLevel?: "debug" | "verbose" | "notice" | "warning";
  readonly redisLogFile?: string;
  readonly startupTimeoutSeconds: number;
  readonly inheritStdio?: boolean;
}

/** Run FalkorDB until SIGINT or SIGTERM, then close it without an implicit save. */
export async function runFalkorDB(options: RunFalkorDBOptions): Promise<void> {
  const storage = options.volume ? await volumeStorage(options.volume, options.profile) : undefined;
  const database = await DurableFalkorDB.open({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
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
      forceBackupOnShutdown: options.forceBackupOnShutdown ?? false,
      shutdownTimeoutMs: options.shutdownTimeoutSeconds * 1000,
      ...(options.staleBackupWarningSeconds === undefined
        ? {}
        : { staleBackupWarningMs: options.staleBackupWarningSeconds * 1000 }),
    },
  });
  logger.info("foreground FalkorDB started", {
    pid: database.pid,
    socketPath: database.socketPath,
    durableStorage: Boolean(storage),
  });
  const shutdown = waitForShutdown();
  try {
    await shutdown.promise;
  } finally {
    await database.close();
    shutdown.dispose();
  }
}

async function volumeStorage(root: string, profile?: string): Promise<DatabricksVolumeStorage> {
  const client = workspaceClient.toLegacyWorkspaceClient(
    await workspaceClient.createWorkspaceClient({ ...(profile ? { profile } : {}) }),
  );
  return new DatabricksVolumeStorage(new DatabricksFileSystem({ root, client, createRoot: true }));
}

interface ShutdownWaiter {
  readonly promise: Promise<void>;
  dispose(): void;
}

function waitForShutdown(): ShutdownWaiter {
  let resolve!: () => void;
  let requested = false;
  const promise = new Promise<void>((value) => {
    resolve = value;
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (requested) return;
      requested = true;
      resolve();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    promise,
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
