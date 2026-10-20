import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChildProcessResult } from "@dbx-tools/core";
import { logger } from "@dbx-tools/shared-core";
import { superviseProcessForever } from "../src/supervisor.ts";

class FakeChild extends EventEmitter {
  killed = false;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  shutdownCalls = 0;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.kill("SIGTERM");
  }
}

const startChild = (children: FakeChild[]) => {
  const child = new FakeChild();
  children.push(child);
  return child as unknown as ChildProcessResult;
};

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
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      children[0]!.emit("exit", 1, null);
      await waitFor(() => children.length === 2);
    } finally {
      await supervisor.stop();
    }
  });

  it("kills the active child and does not restart after stop", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startChild(children),
    });

    await waitFor(() => children.length === 1);
    await supervisor.stop();
    await nextTurn();

    assert.equal(children[0]!.shutdownCalls, 1);
    assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
    assert.equal(children.length, 1);
  });

  it("kills a child that reports a process error before retrying", async () => {
    const children: FakeChild[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      children[0]!.emit("error", new Error("connection failed"));
      await waitFor(() => children.length === 2);
      assert.equal(children[0]!.shutdownCalls, 1);
    } finally {
      await supervisor.stop();
    }
  });

  it("restarts a child after consecutive failed public liveness probes", async () => {
    const children: FakeChild[] = [];
    let probes = 0;
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      healthCheckGraceMs: 1,
      healthCheckIntervalMs: 1,
      healthCheckFailures: 2,
      isHealthy: () => {
        probes += 1;
        return false;
      },
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      await waitFor(() => probes >= 2);
      await waitFor(() => children[0]!.shutdownCalls === 1);
      children[0]!.emit("exit", 1, "SIGTERM");
      await waitFor(() => children.length === 2);
    } finally {
      await supervisor.stop();
    }
  });

  it("does not restart after a parent shutdown signal", async () => {
    const children: FakeChild[] = [];
    const ignore = () => undefined;
    process.on("SIGINT", ignore);
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      process.emit("SIGINT");
      children[0]!.emit("exit", 0, null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(children.length, 1);
      assert.equal(children[0]!.shutdownCalls, 0);
    } finally {
      process.off("SIGINT", ignore);
      await supervisor.stop();
    }
  });

  it("still terminates the child when stop runs after a parent shutdown signal", async () => {
    const children: FakeChild[] = [];
    const ignore = () => undefined;
    process.on("SIGTERM", ignore);
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      process.emit("SIGTERM");
      await nextTurn();
      await supervisor.stop();
      await nextTurn();

      assert.equal(children[0]!.shutdownCalls, 1);
      assert.equal(children.length, 1);
    } finally {
      process.off("SIGTERM", ignore);
    }
  });

  it("does not restart when a single probe fails below the threshold", async () => {
    const children: FakeChild[] = [];
    let probes = 0;
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: logger("test:supervisor"),
      retryDelaysMs: [0],
      healthCheckGraceMs: 1,
      healthCheckIntervalMs: 5,
      healthCheckFailures: 3,
      isHealthy: () => {
        probes += 1;
        // First probe fails; subsequent probes succeed so we never hit threshold.
        return probes > 1;
      },
      start: () => startChild(children),
    });

    try {
      await waitFor(() => children.length === 1);
      await waitFor(() => probes >= 2);
      // Give the supervisor a couple more turns; it must not have killed.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(children[0]!.shutdownCalls, 0);
      assert.equal(children.length, 1);
    } finally {
      await supervisor.stop();
    }
  });
});
