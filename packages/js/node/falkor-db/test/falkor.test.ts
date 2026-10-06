import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableFalkorDB } from "../src/falkor.ts";
import type { VolumeEntry, VolumeStorage } from "../src/persistence/volume.ts";

describe("DurableFalkorDB integration", () => {
  test("removes the process and socket while preserving the local RDB", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "durable falkor close-"));
    const database = await DurableFalkorDB.open({
      dataDir,
      snapshotSeconds: 1,
      snapshotMinChanges: 1,
      handleSignals: false,
      persistence: { pollIntervalMs: 100 },
    });
    await database.selectGraph("cleanup").query("CREATE (:Node {name: 'persisted'})");
    await waitFor(() => existsSync(join(dataDir, "dump.rdb")));
    const socketPath = database.socketPath;
    const pid = database.pid;

    await database.close();

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dataDir, "dump.rdb"))).toBe(true);
    if (pid !== undefined) expect(isProcessRunning(pid)).toBe(false);
  }, 15_000);

  test("automatically backs up changes, stays idle without writes, and restores", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-falkor-"));
    const dataDir = join(root, "active");
    const storage = new MemoryStorage();
    const database = await DurableFalkorDB.open({
      dataDir,
      storage,
      snapshotSeconds: 1,
      snapshotMinChanges: 1,
      handleSignals: false,
      persistence: { pollIntervalMs: 100 },
    });
    await database
      .selectGraph("knowledge")
      .query("CREATE (:Node {name: $name})", { params: { name: "durable" } });

    await waitFor(() => storage.json.has("latest.json"));
    const uploaded = storage.snapshotCount;
    await Bun.sleep(1_200);
    expect(storage.snapshotCount).toBe(uploaded);
    await database.close();

    await rm(dataDir, { recursive: true, force: true });
    const restored = await DurableFalkorDB.open({
      dataDir,
      storage,
      snapshotSeconds: 60,
      handleSignals: false,
      persistence: { pollIntervalMs: 100 },
    });
    expect(await restored.list()).toContain("knowledge");
    expect(restored.persistenceStatus.restoreSnapshotSequence).toBe(1);
    expect(storage.snapshotCount).toBe(1);
    await restored.close();
  }, 20_000);
});

class MemoryStorage implements VolumeStorage {
  readonly files = new Map<string, Buffer>();
  readonly json = new Map<string, unknown>();

  get snapshotCount(): number {
    return [...this.files.keys()].filter((path) => path.endsWith(".rdb")).length;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.json.has(path);
  }

  async download(remote: string, local: string): Promise<void> {
    const value = this.files.get(remote);
    if (!value) throw new Error(`missing ${remote}`);
    await writeFile(local, value);
  }

  async upload(local: string, remote: string): Promise<void> {
    this.files.set(remote, await readFile(local));
  }

  async readJson<T>(path: string): Promise<T | null> {
    return (this.json.get(path) as T | undefined) ?? null;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await Bun.sleep(50);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
