import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FalkorPersistenceManager } from "../src/persistence/manager.ts";
import { parsePersistenceInfo } from "../src/persistence/redis-info.ts";
import type {
  RedisPersistenceClient,
  RedisPersistenceInfo,
} from "../src/persistence/redis-info.ts";
import type { VolumeEntry, VolumeStorage } from "../src/persistence/volume.ts";

describe("FalkorDB durable persistence", () => {
  test("parses Redis INFO persistence", () => {
    expect(
      parsePersistenceInfo(
        "# Persistence\r\nrdb_bgsave_in_progress:0\r\nrdb_last_save_time:42\r\n" +
          "rdb_last_bgsave_status:ok\r\nrdb_changes_since_last_save:3\r\n",
      ),
    ).toEqual({
      rdbBgSaveInProgress: false,
      rdbLastSaveTime: 42,
      rdbLastBgSaveStatus: "ok",
      rdbChangesSinceLastSave: 3,
    });
  });

  test("uploads only a completed new RDB and advances manifest after the snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-manager-"));
    await writeFile(join(dataDir, "dump.rdb"), "snapshot-one");
    const storage = new MemoryStorage();
    const redis = new FakeRedis({
      rdbBgSaveInProgress: false,
      rdbLastSaveTime: 10,
      rdbLastBgSaveStatus: "ok",
      rdbChangesSinceLastSave: 0,
    });
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      pollIntervalMs: 60_000,
    });

    await manager.start(redis);
    await manager.checkNow();
    manager.stop();

    expect(storage.operations).toEqual(["upload:snapshots/00000001.rdb", "json:latest.json"]);
    expect(storage.files.has("snapshots/00000001.rdb")).toBe(true);
    expect(manager.status.backupLastSequence).toBe(1);
  });

  test("fails restore when the durable snapshot checksum is wrong", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-restore-"));
    const storage = new MemoryStorage();
    storage.files.set("snapshots/00000001.rdb", Buffer.from("corrupt"));
    storage.json.set("latest.json", {
      snapshot: "snapshots/00000001.rdb",
      createdAt: new Date().toISOString(),
      size: 7,
      sha256: "0".repeat(64),
      sequence: 1,
    });
    const manager = new FalkorPersistenceManager({ dataDir, storage });

    await expect(manager.restore()).rejects.toThrow("checksum mismatch");
  });

  test("does not force BGSAVE during shutdown by default", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-shutdown-"));
    const redis = new FakeRedis({
      rdbBgSaveInProgress: false,
      rdbLastSaveTime: 10,
      rdbLastBgSaveStatus: "ok",
      rdbChangesSinceLastSave: 2,
    });
    const manager = new FalkorPersistenceManager({ dataDir, pollIntervalMs: 60_000 });
    await manager.start(redis);
    await manager.prepareShutdown();
    expect(redis.bgSaveCalls).toBe(0);
  });

  test("forces a dirty local RDB only when shutdown backup is enabled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-shutdown-opt-in-"));
    const redis = new FakeRedis({
      rdbBgSaveInProgress: false,
      rdbLastSaveTime: 10,
      rdbLastBgSaveStatus: "ok",
      rdbChangesSinceLastSave: 2,
    });
    const manager = new FalkorPersistenceManager({
      dataDir,
      forceBackupOnShutdown: true,
      pollIntervalMs: 60_000,
    });
    await manager.start(redis);
    await manager.prepareShutdown();
    expect(redis.bgSaveCalls).toBe(1);
  });

  test("keeps the previous manifest usable when a newer snapshot upload fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-upload-crash-"));
    const storage = new MemoryStorage();
    storage.files.set("snapshots/00000001.rdb", Buffer.from("previous"));
    const previousManifest = manifest(1, "previous", 10);
    storage.json.set("latest.json", previousManifest);
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      retryDelaysMs: [0],
      pollIntervalMs: 60_000,
    });
    await manager.restore();
    const redis = new FakeRedis(info({ saveTime: 10 }));
    await manager.start(redis);
    await writeFile(join(dataDir, "dump.rdb"), "newer");
    storage.uploadError = new Error("volume unavailable");
    redis.setInfo(info({ saveTime: 11 }));

    await manager.checkNow();
    manager.stop();

    expect(storage.json.get("latest.json")).toEqual(previousManifest);
    expect(manager.status.backupFailures).toBe(1);
  });

  test("catches up after durable storage connectivity returns", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-outage-"));
    await writeFile(join(dataDir, "dump.rdb"), "pending");
    const storage = new MemoryStorage();
    storage.uploadError = new Error("volume unavailable");
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      retryDelaysMs: [0],
      pollIntervalMs: 60_000,
    });
    const redis = new FakeRedis(info({ saveTime: 20 }));

    await manager.start(redis);
    expect(manager.status.backupFailures).toBe(1);
    storage.uploadError = undefined;
    await manager.checkNow();
    manager.stop();

    expect((storage.json.get("latest.json") as { sequence: number }).sequence).toBe(1);
    expect(manager.status.backupLastSequence).toBe(1);
  });

  test("uploads the newest RDB produced while an upload is running", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-coalesce-"));
    await writeFile(join(dataDir, "dump.rdb"), "first");
    const storage = new MemoryStorage();
    const redis = new FakeRedis(info({ saveTime: 30 }));
    storage.onUpload = async (remote) => {
      if (remote.endsWith("00000001.rdb")) {
        await writeFile(join(dataDir, "dump.rdb"), "second");
        redis.setInfo(info({ saveTime: 31 }));
      }
    };
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      pollIntervalMs: 60_000,
    });

    await manager.start(redis);
    manager.stop();

    expect(manager.status.backupLastSequence).toBe(2);
    expect(storage.files.get("snapshots/00000002.rdb")?.toString()).toBe("second");
  });

  test("opt-in shutdown uploads the forced dirty snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-shutdown-upload-"));
    await writeFile(join(dataDir, "dump.rdb"), "before-shutdown");
    const storage = new MemoryStorage();
    const redis = new FakeRedis(info({ saveTime: 40, changes: 2 }));
    redis.onBgSave = async () => writeFile(join(dataDir, "dump.rdb"), "shutdown-state");
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      forceBackupOnShutdown: true,
      pollIntervalMs: 60_000,
    });

    await manager.start(redis);
    await manager.prepareShutdown();

    expect(redis.bgSaveCalls).toBe(1);
    expect(storage.files.get("snapshots/00000002.rdb")?.toString()).toBe("shutdown-state");
  });

  test("serializes an opt-in shutdown backup behind an in-flight upload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "falkor-shutdown-serialize-"));
    await writeFile(join(dataDir, "dump.rdb"), "scheduled-state");
    const storage = new MemoryStorage();
    const redis = new FakeRedis(info({ saveTime: 50 }));
    const manager = new FalkorPersistenceManager({
      dataDir,
      storage,
      forceBackupOnShutdown: true,
      pollIntervalMs: 60_000,
    });
    await manager.start(redis);

    await writeFile(join(dataDir, "dump.rdb"), "in-flight-state");
    redis.setInfo(info({ saveTime: 51 }));
    const uploadStarted = Promise.withResolvers<void>();
    const releaseUpload = Promise.withResolvers<void>();
    storage.onUpload = async (remote) => {
      if (remote.endsWith("00000002.rdb")) {
        uploadStarted.resolve();
        await releaseUpload.promise;
      }
    };
    const inFlight = manager.checkNow();
    await uploadStarted.promise;

    redis.setInfo(info({ saveTime: 51, changes: 2 }));
    redis.onBgSave = async () => writeFile(join(dataDir, "dump.rdb"), "shutdown-state");
    const shutdown = manager.prepareShutdown();
    await Bun.sleep(10);
    expect(storage.maximumConcurrentUploads).toBe(1);

    releaseUpload.resolve();
    await Promise.all([inFlight, shutdown]);

    expect(storage.maximumConcurrentUploads).toBe(1);
    expect(storage.files.get("snapshots/00000003.rdb")?.toString()).toBe("shutdown-state");
  });
});

class FakeRedis implements RedisPersistenceClient {
  bgSaveCalls = 0;
  onBgSave: (() => Promise<void>) | undefined;

  constructor(private infoValue: RedisPersistenceInfo) {}

  async info(): Promise<string> {
    return [
      `rdb_bgsave_in_progress:${this.infoValue.rdbBgSaveInProgress ? 1 : 0}`,
      `rdb_last_save_time:${this.infoValue.rdbLastSaveTime}`,
      `rdb_last_bgsave_status:${this.infoValue.rdbLastBgSaveStatus}`,
      `rdb_changes_since_last_save:${this.infoValue.rdbChangesSinceLastSave}`,
    ].join("\r\n");
  }

  async bgSave(): Promise<void> {
    this.bgSaveCalls += 1;
    await this.onBgSave?.();
    this.infoValue = {
      ...this.infoValue,
      rdbLastSaveTime: this.infoValue.rdbLastSaveTime + 1,
      rdbChangesSinceLastSave: 0,
    };
  }

  setInfo(value: RedisPersistenceInfo): void {
    this.infoValue = value;
  }
}

class MemoryStorage implements VolumeStorage {
  readonly files = new Map<string, Buffer>();
  readonly json = new Map<string, unknown>();
  readonly operations: string[] = [];
  uploadError: Error | undefined;
  onUpload: ((remote: string) => Promise<void>) | undefined;
  maximumConcurrentUploads = 0;
  private concurrentUploads = 0;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.json.has(path);
  }

  async download(remote: string, local: string): Promise<void> {
    const content = this.files.get(remote);
    if (!content) throw new Error(`missing ${remote}`);
    await writeFile(local, content);
  }

  async upload(local: string, remote: string): Promise<void> {
    this.concurrentUploads += 1;
    this.maximumConcurrentUploads = Math.max(this.maximumConcurrentUploads, this.concurrentUploads);
    try {
      this.operations.push(`upload:${remote}`);
      if (this.uploadError) throw this.uploadError;
      this.files.set(remote, await readFile(local));
      await this.onUpload?.(remote);
    } finally {
      this.concurrentUploads -= 1;
    }
  }

  async readJson<T>(path: string): Promise<T | null> {
    return (this.json.get(path) as T | undefined) ?? null;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    this.operations.push(`json:${path}`);
    this.json.set(path, value);
  }

  async list(path: string): Promise<VolumeEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => ({
        name: name.slice(prefix.length),
        path: name,
        size: value.length,
      }));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function info(options: { saveTime: number; changes?: number }): RedisPersistenceInfo {
  return {
    rdbBgSaveInProgress: false,
    rdbLastSaveTime: options.saveTime,
    rdbLastBgSaveStatus: "ok",
    rdbChangesSinceLastSave: options.changes ?? 0,
  };
}

function manifest(
  sequence: number,
  content: string,
  redisSaveTime: number,
): Record<string, unknown> {
  return {
    snapshot: `snapshots/${String(sequence).padStart(8, "0")}.rdb`,
    createdAt: new Date().toISOString(),
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    sequence,
    redisSaveTime,
  };
}
