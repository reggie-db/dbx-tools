import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { AppKitChildProcess } from "@dbx-tools/appkit/child-process";
import type { ChildProcessResult } from "@dbx-tools/core/exec";
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

class FakeManagedProcess {
  readonly child = new FakeChild();
  shutdownCalls = 0;

  get process(): ChildProcessResult {
    return this.child as unknown as ChildProcessResult;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.child.kill("SIGTERM");
  }
}

const startManaged = (processes: FakeManagedProcess[]) => {
  const managed = new FakeManagedProcess();
  processes.push(managed);
  return managed as Pick<AppKitChildProcess, "process" | "shutdown">;
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
    const processes: FakeManagedProcess[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startManaged(processes),
    });

    try {
      await waitFor(() => processes.length === 1);
      processes[0]!.child.emit("exit", 1, null);
      await waitFor(() => processes.length === 2);
    } finally {
      supervisor.stop();
    }
  });

  it("kills the active child and does not restart after stop", async () => {
    const processes: FakeManagedProcess[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startManaged(processes),
    });

    await waitFor(() => processes.length === 1);
    supervisor.stop();
    await nextTurn();

    assert.equal(processes[0]!.shutdownCalls, 1);
    assert.deepEqual(processes[0]!.child.signals, ["SIGTERM"]);
    assert.equal(processes.length, 1);
  });

  it("kills a child that reports a process error before retrying", async () => {
    const processes: FakeManagedProcess[] = [];
    const supervisor = superviseProcessForever({
      name: "test-client",
      logger: log.logger("test:supervisor"),
      retryDelaysMs: [0],
      start: () => startManaged(processes),
    });

    try {
      await waitFor(() => processes.length === 1);
      processes[0]!.child.emit("error", new Error("connection failed"));
      await waitFor(() => processes.length === 2);
      assert.equal(processes[0]!.shutdownCalls, 1);
    } finally {
      supervisor.stop();
    }
  });

  it("restarts a child after consecutive failed public liveness probes", async () => {
    const processes: FakeManagedProcess[] = [];
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
      start: () => startManaged(processes),
    });

    try {
      await waitFor(() => processes.length === 1);
      await waitFor(() => probes >= 2);
      await waitFor(() => processes[0]!.shutdownCalls === 1);
      processes[0]!.child.emit("exit", 1, "SIGTERM");
      await waitFor(() => processes.length === 2);
    } finally {
      supervisor.stop();
    }
  });

  it("does not restart when a single probe fails below the threshold", async () => {
    const processes: FakeManagedProcess[] = [];
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
      start: () => startManaged(processes),
    });

    try {
      await waitFor(() => processes.length === 1);
      await waitFor(() => probes >= 2);
      // Give the supervisor a couple more turns; it must not have killed.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(processes[0]!.shutdownCalls, 0);
      assert.equal(processes.length, 1);
    } finally {
      supervisor.stop();
    }
  });
});
