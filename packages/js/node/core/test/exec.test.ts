import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exec } from "../index.ts";

const MISSING_COMMAND = `dbx-tools-missing-command-${process.pid}`;
const QUIET_STDIO = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const;
const PROCESS_TREE_FIXTURE = join(import.meta.dirname, "fixtures", "process-tree.cjs");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function processTreeFixture(mode: "graceful" | "force" | "late") {
  let ready!: (pid: number) => void;
  let lateReady!: (pid: number) => void;
  const gracefulSignals: string[] = [];
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const lateStarted = new Promise<number>((resolve) => {
    lateReady = resolve;
  });
  const child = exec.spawn(process.execPath, [PROCESS_TREE_FIXTURE, mode], {
    stdin: "ignore",
    stdout: {
      capture: false,
      onLine: (line) => {
        const [event, value] = line.split(":");
        if (event === "term") {
          gracefulSignals.push(value!);
          return;
        }
        const pid = Number.parseInt(value!, 10);
        if (!Number.isSafeInteger(pid)) return;
        if (event === "ready") ready(pid);
        if (event === "late") lateReady(pid);
      },
    },
    stderr: "ignore",
  });
  return { child, started, lateStarted, gracefulSignals };
}

describe("shell-string arguments", () => {
  it("keeps a single argument when options are omitted", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dbx-tools-exec-"));
    const target = join(parent, "created");
    try {
      const result = await exec.spawn(`mkdir ${target}`);
      assert.equal(result.exitCode, 0);
      assert.equal(existsSync(target), true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("missing executable", () => {
  it("returns exit code 127 from spawn when check is omitted", async () => {
    const result = await exec.spawn(MISSING_COMMAND, [], QUIET_STDIO);

    assert.equal(result.exitCode, exec.COMMAND_NOT_FOUND_EXIT_CODE);
    assert.equal(result.exitCode, 127);
  });

  it("returns exit code 127 when missing-command output is captured", async () => {
    const result = await exec.spawn(MISSING_COMMAND, [], {
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
    });

    assert.equal(result.exitCode, exec.COMMAND_NOT_FOUND_EXIT_CODE);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("throws from spawn when check is true", async () => {
    await assert.rejects(
      exec.spawn(MISSING_COMMAND, [], { ...QUIET_STDIO, check: true }),
      /failed \(exit 127\)/,
    );
  });

  it("returns exit code 127 from spawnSync when check is false", () => {
    const result = exec.spawnSync(MISSING_COMMAND, [], { ...QUIET_STDIO, check: false });

    assert.equal(result.exitCode, exec.COMMAND_NOT_FOUND_EXIT_CODE);
    assert.equal(result.exitCode, 127);
  });

  it("throws from spawnSync when check is true", () => {
    assert.throws(
      () => exec.spawnSync(MISSING_COMMAND, [], { ...QUIET_STDIO, check: true }),
      /failed \(exit 127\)/,
    );
  });
});

describe("stdin modes", () => {
  const echoStdin = [
    "process.stdin.setEncoding('utf8');",
    "let input = '';",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => process.stdout.write(input));",
  ].join("");

  it("treats ignore as a stdio mode, not literal input", async () => {
    const result = await exec.spawn(process.execPath, ["-e", echoStdin], {
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
      check: true,
    });

    assert.equal(result.stdout, "");
  });

  it("still writes arbitrary string payloads", async () => {
    const result = await exec.spawn(process.execPath, ["-e", echoStdin], {
      stdin: "hello",
      stdout: "capture",
      stderr: "capture",
      check: true,
    });

    assert.equal(result.stdout, "hello");
  });

  it("ignores EPIPE when a child exits before reading its payload", async () => {
    const payload = "x".repeat(1024 * 1024);
    const result = await exec.spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdin: payload,
      stdout: "ignore",
      stderr: "ignore",
      check: true,
    });

    assert.equal(result.exitCode, 0);
  });
});

describe("live process handle", () => {
  it("returns a value that is BOTH a live child and an awaitable result", async () => {
    // A child that idles until signalled, so the handle is observably live before
    // it resolves.
    const proc = exec.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], QUIET_STDIO);

    // Handle half: it is the live ChildProcess (has a pid, not yet exited).
    assert.equal(typeof proc.pid, "number");
    assert.equal(proc.killed, false);

    // Promise half: awaiting it resolves to the ExecResult once we kill it.
    proc.kill("SIGTERM");
    const result = await proc;
    assert.ok("exitCode" in result);
    assert.equal(proc.killed, true);
  });

  it("resolves the SAME ExecResult whether awaited directly or via then()", async () => {
    const proc = exec.spawn(process.execPath, ["-e", "console.log('hi')"], {
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: true,
    });
    const viaThen = await proc.then((r) => r.stdout);
    assert.equal(viaThen, "hi");
  });

  it("streams lines without retaining them when capture is disabled", async () => {
    const lines: string[] = [];
    const result = await exec.spawn(process.execPath, ["-e", "console.log('hi')"], {
      stdout: { onLine: (line) => lines.push(line), capture: false },
      stderr: "ignore",
      stdin: "ignore",
    });

    assert.deepEqual(lines, ["hi"]);
    assert.deepEqual(result.stdoutLines, []);
    assert.equal(result.stdout, "");
  });
});

describe("process tree termination", () => {
  it("snapshots and gracefully stops a child and its descendants", async () => {
    const { child, started } = processTreeFixture("graceful");
    let descendantPid: number | undefined;
    try {
      descendantPid = await started;
      await exec.kill(child, {
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
        pollIntervalMs: 10,
      });
      await child;

      assert.equal(processExists(child.pid!), false);
      assert.equal(processExists(descendantPid), false);
    } finally {
      forceKill(descendantPid);
      forceKill(child.pid);
      await child.catch(() => undefined);
    }
  });

  it(
    "force-kills snapshot survivors after the graceful timeout",
    { skip: process.platform === "win32" },
    async () => {
      const { child, started, gracefulSignals } = processTreeFixture("force");
      let descendantPid: number | undefined;
      try {
        descendantPid = await started;
        await exec.kill(child, {
          gracefulTimeoutMs: 25,
          forceTimeoutMs: 1_000,
          pollIntervalMs: 5,
        });
        await child;

        assert.equal(child.signalCode, "SIGKILL");
        assert.equal(processExists(descendantPid), false);
        assert.deepEqual(gracefulSignals, ["parent"]);
      } finally {
        forceKill(descendantPid);
        forceKill(child.pid);
        await child.catch(() => undefined);
      }
    },
  );

  it(
    "discovers and signals descendants created during graceful polling",
    { skip: process.platform === "win32" },
    async () => {
      const { child, started, lateStarted } = processTreeFixture("late");
      let descendantPid: number | undefined;
      let latePid: number | undefined;
      try {
        descendantPid = await started;
        const shutdown = exec.kill(child, {
          gracefulTimeoutMs: 250,
          forceTimeoutMs: 1_000,
          pollIntervalMs: 10,
        });
        latePid = await Promise.race([
          lateStarted,
          shutdown.then(() => {
            throw new Error("Process tree exited before the late descendant started");
          }),
        ]);
        await shutdown;
        await child;

        assert.equal(processExists(descendantPid), false);
        assert.equal(processExists(latePid), false);
      } finally {
        forceKill(latePid);
        forceKill(descendantPid);
        forceKill(child.pid);
        await child.catch(() => undefined);
      }
    },
  );
});
