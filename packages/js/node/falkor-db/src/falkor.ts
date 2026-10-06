/**
 * Embedded local FalkorDB with optional durable Volume recovery.
 *
 * This module owns the reusable lifecycle: restore before process start, a
 * private Unix socket, Redis change-aware RDB policy, completed-snapshot
 * observation, and `NOSAVE` shutdown. Applications should reuse
 * {@link DurableFalkorDB} rather than spawning Redis or attaching backup logic
 * around FalkorDBLite themselves. TCP remains opt-in and loopback-only at the
 * CLI boundary.
 *
 * @module
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "@dbx-tools/shared-core";
import { FalkorDB as FalkorClient, type Graph } from "falkordb";
import {
  BinaryManager,
  ConfigGenerator,
  ServerManager,
  unregisterServer,
  type FalkorDBLiteOptions,
} from "falkordblite";
import { createClient } from "redis";
import {
  FalkorPersistenceManager,
  type FalkorPersistenceOptions,
  type FalkorPersistenceStatus,
} from "./persistence/manager.ts";
import type { VolumeStorage } from "./persistence/volume.ts";

const require = createRequire(import.meta.url);
const logger = log.logger("falkor-db");

/** Configuration for {@link DurableFalkorDB.open}. */
export interface DurableFalkorDBOptions extends Pick<
  FalkorDBLiteOptions,
  | "redisServerPath"
  | "modulePath"
  | "maxMemory"
  | "logLevel"
  | "logFile"
  | "timeout"
  | "inheritStdio"
> {
  /** Local active-database directory. Defaults to `FALKORDB_DATA_DIR`. */
  dataDir?: string;
  /** Deterministic private Unix socket path. Defaults to a random path under `dataDir`. */
  socketPath?: string;
  /** Optional loopback TCP port. Defaults to zero, which disables TCP. */
  port?: number;
  /** Redis snapshot interval. Defaults to `FALKORDB_SNAPSHOT_SECONDS` or 300. */
  snapshotSeconds?: number;
  /** Minimum writes in an interval. Defaults to `FALKORDB_SNAPSHOT_MIN_CHANGES` or 1. */
  snapshotMinChanges?: number;
  /** Extra redis.conf settings. `save`, TCP, module, and data paths remain owned here. */
  redisConfig?: Readonly<Record<string, string>>;
  /** Optional durable snapshot destination, typically a Databricks Volume. */
  storage?: VolumeStorage;
  /** Durable-backup and shutdown policy. */
  persistence?: Omit<FalkorPersistenceOptions, "dataDir" | "storage">;
  /** Install SIGINT/SIGTERM handlers. Defaults to true. */
  handleSignals?: boolean;
}

/** Embedded FalkorDB graph client plus durable persistence lifecycle. */
export class DurableFalkorDB {
  private closing: Promise<void> | undefined;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  private constructor(
    private readonly graphClient: FalkorClient,
    private readonly adminClient: ReturnType<typeof createClient>,
    private readonly server: ServerManager,
    private readonly persistence: FalkorPersistenceManager,
  ) {}

  /** Restore durable state, start FalkorDBLite, and connect through its Unix socket. */
  static async open(options: DurableFalkorDBOptions = {}): Promise<DurableFalkorDB> {
    const dataDir = options.dataDir ?? process.env.FALKORDB_DATA_DIR ?? defaultDataDirectory();
    const snapshotSeconds = positiveInteger(
      options.snapshotSeconds ?? process.env.FALKORDB_SNAPSHOT_SECONDS ?? 300,
      "snapshotSeconds",
    );
    const snapshotMinChanges = positiveInteger(
      options.snapshotMinChanges ?? process.env.FALKORDB_SNAPSHOT_MIN_CHANGES ?? 1,
      "snapshotMinChanges",
    );
    const persistence = new FalkorPersistenceManager({
      ...options.persistence,
      dataDir,
      storage: options.storage,
    });
    await persistence.restore();

    const binaries = resolveBinaries(options);
    const socketPath =
      options.socketPath ??
      join(
        tmpdir(),
        options.port !== undefined
          ? `dbx-tools-falkor-${options.port}-${createHash("sha256").update(dataDir).digest("hex").slice(0, 12)}.sock`
          : `dbx-tools-falkor-${randomBytes(8).toString("hex")}.sock`,
      );
    const config = new ConfigGenerator({
      dbDir: redisConfigArgument(dataDir),
      falkordbModulePath: redisConfigArgument(binaries.modulePath),
      unixSocketPath: redisConfigArgument(socketPath),
      port: options.port ?? 0,
      maxMemory: options.maxMemory,
      logLevel: options.logLevel,
      logFile: options.logFile ? redisConfigArgument(options.logFile) : undefined,
      additionalConfig: {
        ...options.redisConfig,
        save: `${snapshotSeconds} ${snapshotMinChanges}`,
      },
    });
    const server = new ServerManager({
      redisServerPath: binaries.redisServerPath,
      config: config.generate(),
      socketPath,
      startupTimeoutMs: options.timeout,
      inheritStdio: options.inheritStdio,
    });
    await server.start();
    unregisterServer(server);

    let graphClient: FalkorClient | undefined;
    let adminClient: ReturnType<typeof createClient> | undefined;
    try {
      graphClient = await FalkorClient.connect({ socket: { path: server.socketPath } });
      adminClient = createClient({
        socket: { path: server.socketPath, tls: false, reconnectStrategy: false },
      });
      adminClient.on("error", (error) => {
        logger.debug("Redis administration connection error", { error });
      });
      await adminClient.connect();
      await persistence.start(adminClient);
      const database = new DurableFalkorDB(graphClient, adminClient, server, persistence);
      if (options.handleSignals ?? true) database.installSignalHandlers();
      return database;
    } catch (error) {
      persistence.stop();
      adminClient?.destroy();
      await graphClient?.close().catch(() => undefined);
      await server.stop(false);
      throw error;
    }
  }

  /** Select a graph using the exact `falkordb` package {@link Graph} type. */
  selectGraph(graphId: string): Graph {
    return this.graphClient.selectGraph(graphId);
  }

  /** List graphs in the embedded database. */
  list(): Promise<string[]> {
    return this.graphClient.list();
  }

  /** Current local/durable persistence health fields. */
  get persistenceStatus(): Readonly<FalkorPersistenceStatus> {
    return this.persistence.status;
  }

  /** Unix socket used by the embedded Redis/FalkorDB process. */
  get socketPath(): string {
    return this.server.socketPath;
  }

  /** Embedded Redis process id, when running. */
  get pid(): number | undefined {
    return this.server.getPid();
  }

  /** Stop polling and terminate with `SHUTDOWN NOSAVE`. */
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.removeSignalHandlers();
    await this.persistence.prepareShutdown();
    await this.graphClient.close().catch(() => undefined);
    await this.adminClient.close().catch(() => this.adminClient.destroy());
    await this.server.stop(false);
  }

  private installSignalHandlers(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        void this.close().finally(() => process.kill(process.pid, signal));
      };
      this.signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  private removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.clear();
  }
}

interface ResolvedBinaries {
  redisServerPath: string;
  modulePath: string;
}

function resolveBinaries(options: DurableFalkorDBOptions): ResolvedBinaries {
  if (options.redisServerPath && options.modulePath) {
    return { redisServerPath: options.redisServerPath, modulePath: options.modulePath };
  }
  const platform = BinaryManager.detectPlatform();
  const packageName = `@falkordblite/${platform}`;
  let packageDirectory: string;
  try {
    packageDirectory = dirname(require.resolve(`${packageName}/package.json`));
  } catch (error) {
    throw new Error(
      `Missing ${packageName}; install the platform package or provide redisServerPath and modulePath`,
      { cause: error },
    );
  }
  const redisServerPath = options.redisServerPath ?? join(packageDirectory, "bin", "redis-server");
  const modulePath = options.modulePath ?? join(packageDirectory, "bin", "falkordb.so");
  if (!existsSync(redisServerPath) || !existsSync(modulePath)) {
    throw new Error(`FalkorDBLite platform package ${packageName} is missing its bundled binaries`);
  }
  return { redisServerPath, modulePath };
}

function defaultDataDirectory(): string {
  return join(tmpdir(), process.env.DATABRICKS_APP_NAME ?? "dbx-tools", "falkordb");
}

function positiveInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function redisConfigArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export type { Graph } from "falkordb";
