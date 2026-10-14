import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LakeboxMetrics, parseLakeboxCounters, toSnapshot } from "../src/metrics.ts";

const sample = (busy: number, idle: number, rx: number, tx: number) =>
  [
    "cores 4",
    `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0`,
    "load 0.5",
    "MemTotal: 8000000",
    "MemAvailable: 6000000",
    "storage 100000 25000",
    `network ${rx} ${tx}`,
  ].join("\n");

describe("Lakebox metrics", () => {
  it("computes CPU, memory, storage, and network rates without process data", () => {
    const first = parseLakeboxCounters(sample(100, 900, 1_000, 2_000), 0);
    const second = parseLakeboxCounters(sample(150, 950, 3_000, 2_500), 1_000);
    const snapshot = toSnapshot(second, first);
    assert.equal(snapshot.cpu.usedPercent, 50);
    assert.equal(snapshot.cpu.cores, 4);
    assert.equal(snapshot.memory.usedBytes, 2_000_000 * 1024);
    assert.deepEqual(snapshot.storage, { totalBytes: 100_000, usedBytes: 25_000 });
    assert.deepEqual(snapshot.network, { rxBytesPerSecond: 2_000, txBytesPerSecond: 500 });
    assert.equal(JSON.stringify(snapshot).includes("pid"), false);
  });

  it("rejects incomplete output", () => {
    assert.throws(() => parseLakeboxCounters("cores 4"), /missing/);
  });

  it("seeds readiness without starting or emitting", () => {
    const metrics = new LakeboxMetrics(async () => sample(0, 0, 0, 0), 5);
    let emitted = false;
    metrics.on("snapshot", () => (emitted = true));
    const snapshot = metrics.seed(sample(100, 900, 1_000, 2_000), 1_000);
    assert.equal(metrics.running, false);
    assert.equal(emitted, false);
    assert.deepEqual(metrics.series(), [snapshot]);
  });

  it("samples only between start and stop", async () => {
    let reads = 0;
    const metrics = new LakeboxMetrics(async () => {
      reads += 1;
      return sample(reads * 10, 100, reads, reads);
    }, 5);
    const snapshots: unknown[] = [];
    metrics.on("snapshot", (snapshot) => snapshots.push(snapshot));
    metrics.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    metrics.stop();
    const stopped = reads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(snapshots.length >= 2);
    assert.equal(reads, stopped);
    assert.deepEqual(metrics.series(), []);
  });
});
