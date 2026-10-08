import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppKitChildProcess } from "../src/child-process.ts";

function readyProcess(source: string, options = {}) {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const managed = new AppKitChildProcess(
    [
      process.execPath,
      ["-e", source],
      {
        detached: process.platform !== "win32",
        stdin: "ignore",
        stdout: { onLine: (line) => line === "ready" && ready(), capture: false },
        stderr: "ignore",
      },
    ],
    options,
  );
  const child = managed.start();
  return { managed, child, started };
}

describe("AppKitChildProcess", () => {
  it("uses core exec options and shuts down gracefully once", async () => {
    const { managed, child, started } = readyProcess(
      "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)",
    );
    await started;

    const first = managed.shutdown();
    assert.equal(managed.shutdown(), first);
    await first;
    const result = await child;

    assert.equal(result.exitCode, 0);
    assert.equal(managed.running, false);
    assert.equal(managed.process, undefined);
    assert.throws(() => managed.start(), /shutting down or has been shut down/);
  });

  it("force-kills a detached process group after the graceful timeout", async () => {
    const { managed, child, started } = readyProcess(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      { gracefulTimeoutMs: 10, forceTimeoutMs: 1_000 },
    );
    await started;

    await managed.shutdown();
    await child;

    assert.equal(child.signalCode, "SIGKILL");
    assert.equal(managed.running, false);
  });
});
