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
});
