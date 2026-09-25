import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { log } from "@dbx-tools/shared-core";
import { superviseProcessForever } from "../src/supervisor.ts";

class FakeChild extends EventEmitter {
  killed = false;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("condition was not met");
};

describe("superviseProcessForever", () => {
  it("restarts a child after it exits", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    try {
      await waitFor(() => children.length === 1);
      children[0]!.emit("exit", 1, null);
      await waitFor(() => children.length === 2);
    } finally {
      supervisor.stop();
    }
  });

  it("kills the active child and does not restart after stop", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    await waitFor(() => children.length === 1);
    supervisor.stop();
    await nextTurn();

    assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
    assert.equal(children.length, 1);
  });

  it("force-kills a child that ignores SIGTERM", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      shutdownGraceMs: 1,
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    await waitFor(() => children.length === 1);
    supervisor.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("kills a child that reports a process error before retrying", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    try {
      await waitFor(() => children.length === 1);
      children[0]!.emit("error", new Error("connection failed"));
      await waitFor(() => children.length === 2);
      assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
    } finally {
      supervisor.stop();
    }
  });

  it("restarts a child after consecutive failed public liveness probes", async () => {
    const children: FakeChild[] = [];
    let probes = 0;
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      healthCheckGraceMs: 1,
      healthCheckIntervalMs: 1,
      healthCheckFailures: 2,
      isHealthy: () => {
        probes += 1;
        return false;
      },
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    try {
      await waitFor(() => children.length === 1);
      await waitFor(() => probes >= 2);
      await waitFor(() => children[0]!.signals.includes("SIGTERM"));
      children[0]!.emit("exit", 1, "SIGTERM");
      await waitFor(() => children.length === 2);
    } finally {
      supervisor.stop();
    }
  });

  it("does not restart when a single probe fails below the threshold", async () => {
    const children: FakeChild[] = [];
    let probes = 0;
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      healthCheckGraceMs: 1,
      healthCheckIntervalMs: 5,
      healthCheckFailures: 3,
      isHealthy: () => {
        probes += 1;
        // First probe fails; subsequent probes succeed so we never hit threshold.
        return probes > 1;
      },
      start: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    try {
      await waitFor(() => children.length === 1);
      await waitFor(() => probes >= 2);
      // Give the supervisor a couple more turns; it must not have killed.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(children[0]!.signals.length, 0);
      assert.equal(children.length, 1);
    } finally {
      supervisor.stop();
    }
  });
});
