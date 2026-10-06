/**
 * Restore and change-aware durable backup lifecycle for embedded FalkorDB.
 *
 * Redis owns dirty detection and RDB creation. This manager only observes
 * completed saves, stages immutable copies, and advances durable storage after
 * a successful upload. Reuse it instead of adding application-local backup
 * timers, manifest ordering, retry, or retention logic.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { asyncUtils, log } from "@dbx-tools/shared-core";
import {
  enforceRetention,
  LATEST_MANIFEST_PATH,
  nextSnapshotSequence,
  parseSnapshotManifest,
  snapshotPath,
  type SnapshotManifest,
} from "./manifest.ts";
import {
  getPersistenceInfo,
  waitForBackgroundSave,
  type RedisPersistenceClient,
  type RedisPersistenceInfo,
} from "./redis-info.ts";
import { stageSnapshot, verifySnapshot } from "./snapshot.ts";
import type { VolumeStorage } from "./volume.ts";

const logger = log.logger("falkor-db:persistence");
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000] as const;

/** Configuration for {@link FalkorPersistenceManager}. */
export interface FalkorPersistenceOptions {
  dataDir: string;
  storage?: VolumeStorage;
  pollIntervalMs?: number;
  retention?: number;
  retryDelaysMs?: readonly number[];
  forceBackupOnShutdown?: boolean;
  shutdownTimeoutMs?: number;
  staleBackupWarningMs?: number;
}

/** Observable state for health reporting and metrics adapters. */
export interface FalkorPersistenceStatus {
  rdbLastSaveTime?: number;
  rdbChangesSinceLastSave?: number;
  backupLastSuccessTime?: string;
  backupLastSequence?: number;
  backupSizeBytes?: number;
  backupDurationMs?: number;
  backupFailures: number;
  restoreDurationMs?: number;
  restoreSnapshotSequence?: number;
}

/** Coordinates restore, RDB observation, durable upload, retry, and retention. */
export class FalkorPersistenceManager {
  private readonly dumpPath: string;
  private readonly stagingDirectory: string;
  private readonly statusValue: FalkorPersistenceStatus = { backupFailures: 0 };
  private manifest: SnapshotManifest | undefined;
  private redis: RedisPersistenceClient | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private backupPromise: Promise<void> | undefined;
  private checkAgain = false;
  private lastUploadedSaveTime = 0;
  private retryAttempt = 0;
  private retryAfter = 0;
  private lastLoggedLocalSaveTime = 0;

  constructor(private readonly options: FalkorPersistenceOptions) {
    this.dumpPath = join(options.dataDir, "dump.rdb");
    this.stagingDirectory = join(options.dataDir, ".dbx-tools-backups");
  }

  get status(): Readonly<FalkorPersistenceStatus> {
    return { ...this.statusValue };
  }

  /** Restore `latest.json` before FalkorDB starts, or keep the local database. */
  async restore(): Promise<SnapshotManifest | undefined> {
    await mkdir(this.options.dataDir, { recursive: true });
    if (!this.options.storage) {
      logger.info("durable storage is not configured; using local RDB persistence", {
        dataDir: this.options.dataDir,
      });
      return undefined;
    }

    const raw = await this.options.storage.readJson<unknown>(LATEST_MANIFEST_PATH);
    if (raw === null) {
      logger.info("no durable FalkorDB snapshot found; using local database", {
        dataDir: this.options.dataDir,
      });
      return undefined;
    }

    const started = Date.now();
    const manifest = parseSnapshotManifest(raw);
    const temporary = `${this.dumpPath}.restore`;
    await rm(temporary, { force: true });
    try {
      await this.options.storage.download(manifest.snapshot, temporary);
      await verifySnapshot(temporary, manifest.sha256);
      await rename(temporary, this.dumpPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    this.manifest = manifest;
    this.lastUploadedSaveTime = manifest.redisSaveTime ?? 0;
    this.statusValue.restoreDurationMs = Date.now() - started;
    this.statusValue.restoreSnapshotSequence = manifest.sequence;
    logger.info("restored FalkorDB snapshot", {
      sequence: manifest.sequence,
      size: manifest.size,
      durationMs: this.statusValue.restoreDurationMs,
    });
    return manifest;
  }

  /** Begin polling Redis persistence metadata for completed new snapshots. */
  async start(redis: RedisPersistenceClient): Promise<void> {
    if (this.timer) return;
    this.redis = redis;
    const initial = await this.observe(redis);
    if (this.manifest) {
      this.lastUploadedSaveTime = initial.rdbLastSaveTime;
    }
    await this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow().catch((error) => {
        logger.error("FalkorDB persistence check failed; retrying later", { error });
      });
    }, this.options.pollIntervalMs ?? 10_000);
    this.timer.unref?.();
  }

  /** Stop background polling without forcing a save or upload. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Inspect persistence now, coalescing concurrent checks into the newest RDB. */
  async checkNow(): Promise<void> {
    if (!this.redis) return;
    if (this.backupPromise) {
      this.checkAgain = true;
      return this.backupPromise;
    }
    this.backupPromise = this.runChecks();
    try {
      await this.backupPromise;
    } finally {
      this.backupPromise = undefined;
    }
  }

  /** Optionally force one dirty save/upload, bounded so shutdown cannot hang. */
  async prepareShutdown(): Promise<void> {
    this.stop();
    if (!this.options.forceBackupOnShutdown || !this.redis) return;
    const timeoutMs = this.options.shutdownTimeoutMs ?? 30_000;
    const work = this.finishShutdownBackup(this.redis);
    const timeout = new AbortController();
    try {
      await Promise.race([
        work,
        asyncUtils.sleep(timeoutMs, timeout.signal).then(() => {
          throw new Error(`FalkorDB shutdown backup exceeded ${timeoutMs}ms`);
        }),
      ]);
    } catch (error) {
      logger.error("shutdown backup failed; continuing shutdown", { error });
    } finally {
      timeout.abort();
    }
  }

  private async finishShutdownBackup(redis: RedisPersistenceClient): Promise<void> {
    if (this.backupPromise) {
      try {
        await this.backupPromise;
      } catch (error) {
        logger.warn("in-flight FalkorDB backup failed; retrying during shutdown", { error });
      }
    }
    await this.forceDirtySnapshot(redis);
  }

  private async runChecks(): Promise<void> {
    do {
      this.checkAgain = false;
      await this.inspectAndBackup();
    } while (this.checkAgain);
  }

  private async inspectAndBackup(): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    const info = await this.observe(redis);
    if (info.rdbBgSaveInProgress) return;
    if (info.rdbLastBgSaveStatus !== "ok") {
      logger.error("Redis reported an unsuccessful background save", {
        status: info.rdbLastBgSaveStatus,
      });
      return;
    }
    this.warnIfStale(info);
    if (!this.options.storage) {
      if (info.rdbLastSaveTime > this.lastLoggedLocalSaveTime) {
        this.lastLoggedLocalSaveTime = info.rdbLastSaveTime;
        logger.info("local FalkorDB RDB snapshot completed", {
          lastSaveTime: info.rdbLastSaveTime,
          changesSinceSave: info.rdbChangesSinceLastSave,
          path: this.dumpPath,
        });
      }
      return;
    }
    if (info.rdbLastSaveTime <= this.lastUploadedSaveTime || !existsSync(this.dumpPath)) return;
    if (Date.now() < this.retryAfter) return;

    try {
      await this.upload(info);
      this.retryAttempt = 0;
      this.retryAfter = 0;
      const newest = await this.observe(redis);
      if (newest.rdbLastSaveTime > this.lastUploadedSaveTime) this.checkAgain = true;
    } catch (error) {
      this.statusValue.backupFailures += 1;
      const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      const delay = asyncUtils.boundedRetryDelay(this.retryAttempt++, delays);
      this.retryAfter = Date.now() + delay;
      logger.error("durable FalkorDB backup failed; local database remains available", {
        error,
        retryInMs: delay,
      });
    }
  }

  private async upload(info: RedisPersistenceInfo): Promise<void> {
    const storage = this.options.storage;
    if (!storage) return;
    const started = Date.now();
    const sequence = await nextSnapshotSequence(storage, this.manifest);
    const remote = snapshotPath(sequence);
    const stagedPath = join(this.stagingDirectory, `snapshot-${sequence}.rdb`);
    const staged = await stageSnapshot(this.dumpPath, stagedPath);
    try {
      await storage.upload(staged.path, remote, { overwrite: false });
      const manifest: SnapshotManifest = {
        snapshot: remote,
        createdAt: new Date().toISOString(),
        size: staged.size,
        sha256: staged.sha256,
        sequence,
        redisSaveTime: info.rdbLastSaveTime,
      };
      await storage.writeJson(LATEST_MANIFEST_PATH, manifest);
      this.manifest = manifest;
      this.lastUploadedSaveTime = info.rdbLastSaveTime;
      this.statusValue.backupLastSuccessTime = manifest.createdAt;
      this.statusValue.backupLastSequence = sequence;
      this.statusValue.backupSizeBytes = staged.size;
      this.statusValue.backupDurationMs = Date.now() - started;
      logger.info("uploaded durable FalkorDB snapshot", {
        sequence,
        size: staged.size,
        durationMs: this.statusValue.backupDurationMs,
      });
      await enforceRetention(storage, manifest, this.options.retention ?? 5).catch((error) => {
        logger.warn("FalkorDB snapshot retention cleanup failed", { error });
      });
    } finally {
      await rm(stagedPath, { force: true });
    }
  }

  private async forceDirtySnapshot(redis: RedisPersistenceClient): Promise<void> {
    let info = await this.observe(redis);
    if (info.rdbChangesSinceLastSave > 0) {
      const previous = info.rdbLastSaveTime;
      await redis.bgSave();
      info = await waitForBackgroundSave(redis, previous, {
        timeoutMs: this.options.shutdownTimeoutMs ?? 30_000,
      });
    }
    if (this.options.storage && info.rdbLastSaveTime > this.lastUploadedSaveTime) {
      this.retryAfter = 0;
      await this.upload(info);
    }
  }

  private async observe(redis: RedisPersistenceClient): Promise<RedisPersistenceInfo> {
    const info = await getPersistenceInfo(redis);
    this.statusValue.rdbLastSaveTime = info.rdbLastSaveTime;
    this.statusValue.rdbChangesSinceLastSave = info.rdbChangesSinceLastSave;
    return info;
  }

  private warnIfStale(info: RedisPersistenceInfo): void {
    if (!this.options.storage) return;
    const threshold = this.options.staleBackupWarningMs;
    if (!threshold || info.rdbChangesSinceLastSave === 0) return;
    const last = this.statusValue.backupLastSuccessTime
      ? Date.parse(this.statusValue.backupLastSuccessTime)
      : 0;
    if (Date.now() - last > threshold) {
      logger.warn("FalkorDB has changes without a recent durable backup", {
        changesSinceSave: info.rdbChangesSinceLastSave,
        lastSuccessTime: this.statusValue.backupLastSuccessTime,
      });
    }
  }
}
