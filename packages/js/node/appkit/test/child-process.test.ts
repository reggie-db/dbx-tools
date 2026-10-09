import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppKitChildProcess, type AppKitChildProcessOptions } from "../src/child-process.ts";

function readyProcess(source: string, options: AppKitChildProcessOptions = {}) {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const managed = new AppKitChildProcess(
    [
      process.execPath,
      ["-e", source],
      {
        stdin: "ignore",
        stdout: { onLine: (line) => line === "ready" && ready(), capture: false },
        stderr: "ignore",
      },
    ],
    options,
  );
  const starting = managed.start();
  const child = managed.process!;
  return { managed, child, started, starting };
}

describe("AppKitChildProcess", () => {
  it("uses core exec options and shuts down gracefully once", async () => {
    const { managed, child, started, starting } = readyProcess(
      "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)",
    );
    await started;
    await starting;
    assert.equal(managed.process, child);

    const first = managed.shutdown();
    assert.equal(managed.shutdown(), first);
    await first;
    const result = await child;

    assert.equal(result.exitCode, 0);
    assert.equal(managed.running, false);
    assert.equal(managed.process, undefined);
    assert.throws(() => managed.start(), /shutting down or has been shut down/);
  });

  it("force-kills the process tree after the graceful timeout", async () => {
    const { managed, child, started, starting } = readyProcess(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      { gracefulTimeoutMs: 10, forceTimeoutMs: 1_000 },
    );
    await started;
    await starting;

    await managed.shutdown();
    await child;

    assert.equal(child.signalCode, "SIGKILL");
    assert.equal(managed.running, false);
  });

  it("runs a foreground child and removes parent signal handlers", async () => {
    const signals = ["SIGINT", "SIGTERM"] as const;
    const listenerCounts = signals.map((signal) => process.listenerCount(signal));
    const managed = new AppKitChildProcess([
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 10)"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ]);

    const result = await managed.run({ signals });

    assert.equal(result.exitCode, 0);
    assert.equal(managed.running, false);
    assert.deepEqual(
      signals.map((signal) => process.listenerCount(signal)),
      listenerCounts,
    );
  });

  it("rejects SIGKILL as an interceptable foreground signal", async () => {
    const managed = new AppKitChildProcess([
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ]);

    await assert.rejects(managed.run({ signals: ["SIGKILL"] }), /cannot be intercepted/);
    assert.equal(managed.process, undefined);
  });

  it("supports programmatic force-only shutdown", async () => {
    const { managed, child, started, starting } = readyProcess(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
    );
    await started;
    await starting;

    await managed.shutdown("SIGKILL");
    await child;

    assert.equal(child.signalCode, "SIGKILL");
  });

  it("polls the optional health check before start resolves", async () => {
    const attempts: number[] = [];
    const managed = new AppKitChildProcess(
      [process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdin: "ignore" }],
      {
        healthCheck: ({ attempt, process: child, signal }) => {
          attempts.push(attempt);
          assert.equal(child, managed.process);
          assert.equal(signal.aborted, false);
          return attempt === 2;
        },
        healthCheckIntervalMs: 5,
        healthCheckTimeoutMs: 1_000,
      },
    );

    await managed.start();
    const child = managed.process!;
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.equal(child, managed.process);
    await managed.shutdown();
    await child;
  });

  it("kills the child and rejects start when the health check fails", async () => {
    const managed = new AppKitChildProcess(
      [process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdin: "ignore" }],
      {
        healthCheck: () => {
          throw new Error("health check failed");
        },
      },
    );

    const starting = managed.start();
    const child = managed.process!;
    await assert.rejects(starting, /health check failed/);
    await child;

    assert.equal(managed.running, false);
  });

  it("kills the child when the health check times out", async () => {
    const managed = new AppKitChildProcess(
      [process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdin: "ignore" }],
      {
        healthCheck: () => false,
        healthCheckIntervalMs: 5,
        healthCheckTimeoutMs: 20,
      },
    );

    const starting = managed.start();
    const child = managed.process!;
    await assert.rejects(starting, { name: "TimeoutError" });
    await child;

    assert.equal(managed.running, false);
  });

  it("aborts an active health check before killing the child", async () => {
    let checking!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      checking = resolve;
    });
    let aborted = false;
    const managed = new AppKitChildProcess(
      [process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdin: "ignore" }],
      {
        healthCheck: ({ signal }) => {
          checking();
          return new Promise<boolean>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
    );

    const starting = managed.start();
    const child = managed.process!;
    await checkStarted;
    await managed.shutdown();
    await assert.rejects(starting, { name: "AbortError" });
    await child;

    assert.equal(aborted, true);
    assert.equal(managed.running, false);
  });
});
