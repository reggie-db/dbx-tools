import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";
import { ensureProjectMachineRunning } from "../src/react/project-machine-readiness.ts";

function machine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: "machine-1",
    name: "Machine 1",
    provider: "databricks-sandbox",
    status: "stopped",
    expiresAt: "2026-10-14T12:00:00.000Z",
    projects: [],
    services: [],
    canStart: true,
    canStop: false,
    canConnect: true,
    ...overrides,
  };
}

describe("ensureProjectMachineRunning", () => {
  it("returns a running machine without starting it again", async () => {
    const running = machine({ status: "running", canStart: false, canStop: true });
    let starts = 0;
    const result = await ensureProjectMachineRunning(
      [running],
      running.id,
      async () => {
        starts += 1;
        return running;
      },
      () => assert.fail("running machines should not be updated"),
    );

    assert.equal(result, running);
    assert.equal(starts, 0);
  });

  it("shows starting state and waits for the running response", async () => {
    const stopped = machine();
    const running = machine({ status: "running", canStart: false, canStop: true });
    const updates: SshMachine[] = [];
    let finishStart!: (value: SshMachine) => void;
    const start = new Promise<SshMachine>((resolve) => {
      finishStart = resolve;
    });
    let resolved = false;
    const pending = ensureProjectMachineRunning(
      [stopped],
      stopped.id,
      async () => start,
      (value) => updates.push(value),
    ).then((value) => {
      resolved = true;
      return value;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.deepEqual(
      updates.map((value) => value.status),
      ["starting"],
    );

    finishStart(running);
    assert.equal(await pending, running);
    assert.deepEqual(
      updates.map((value) => value.status),
      ["starting", "running"],
    );
  });

  it("rejects a start response that is not running", async () => {
    await assert.rejects(
      ensureProjectMachineRunning(
        [machine()],
        "machine-1",
        async () => machine({ status: "starting", canStart: false, canStop: true }),
        () => undefined,
      ),
      /did not reach the running state/,
    );
  });
});
