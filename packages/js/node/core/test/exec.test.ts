import assert from "node:assert/strict";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "../index.ts";

const MISSING_COMMAND = `dbx-tools-missing-command-${process.pid}`;
const QUIET_STDIO = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const;
const PROCESS_TREE_FIXTURE = join(import.meta.dirname, "fixtures", "process-tree.cjs");
const SIGNAL_FORWARDING_FIXTURE = join(import.meta.dirname, "fixtures", "signal-forwarding.ts");

interface SignalFixtureState {
  parentPid: number;
  pids: number[];
  listenerCount: number;
  baselineListenerCount?: number;
}

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

async function signalFixtureState(path: string): Promise<SignalFixtureState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as SignalFixtureState;
    await delay(10);
  }
  throw new Error(`Signal fixture did not become ready: ${path}`);
}

async function signalLines(path: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= count) return lines;
    }
    await delay(10);
  }
  throw new Error(`Signal fixture did not record ${count} signals: ${path}`);
}

async function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
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

  it(
    "preserves an explicit executable path containing spaces",
    { skip: process.platform === "win32" },
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "dbx tools exec-"));
      const executable = join(parent, "print-argument");
      try {
        writeFileSync(
          executable,
          `#!${process.execPath}\nprocess.stdout.write(process.argv[2] ?? "");\n`,
        );
        chmodSync(executable, 0o755);

        const result = await exec.spawn(executable, ["value"], {
          stdin: "ignore",
          stdout: "capture",
          stderr: "capture",
          check: true,
        });

        assert.equal(result.stdout, "value");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
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

    // Promise half: awaiting it resolves to the ExecResult once we shut it down.
    await proc.shutdown({ terminateTimeout: 0, killTimeout: 1_000 });
    const result = await proc;
    assert.ok("exitCode" in result);
    assert.equal(proc.exitCode !== null || proc.signalCode !== null, true);
  });

  it("keeps process signal selection internal", async () => {
    assert.throws(
      () =>
        exec.spawn(process.execPath, ["-e", ""], {
          ...QUIET_STDIO,
          killSignal: "SIGKILL",
        } as never),
      /Process signals are selected internally/,
    );
    assert.throws(
      () =>
        exec.spawnSync(process.execPath, ["-e", ""], {
          ...QUIET_STDIO,
          killSignal: "SIGKILL",
        } as never),
      /Process signals are selected internally/,
    );

    const child = exec.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], QUIET_STDIO);
    try {
      assert.throws(
        () => child.shutdown({ terminateSignal: "SIGINT" } as never),
        /Process signals are selected internally/,
      );
    } finally {
      await child.shutdown({ terminateTimeout: 0, killTimeout: 1_000 });
      await child;
    }
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

describe("parent signal forwarding", () => {
  it("uses one global listener and shuts down every tracked child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-"));
    const readyPath = join(directory, "ready.json");
    const signalPath = join(directory, "signals.log");
    const parent = nativeSpawn(
      process.execPath,
      [SIGNAL_FORWARDING_FIXTURE, "async-default", readyPath, signalPath],
      { stdio: "ignore" },
    );
    let state: SignalFixtureState | undefined;
    try {
      state = await signalFixtureState(readyPath);
      assert.equal(state.listenerCount - (state.baselineListenerCount ?? 0), 1);
      assert.equal(state.pids.length, 2);

      process.kill(parent.pid!, "SIGTERM");
      await childExit(parent);
      const lines = await signalLines(signalPath, 2);

      assert.deepEqual(lines.toSorted(), ["0:SIGTERM", "1:SIGTERM"]);
      assert.equal(
        state.pids.every((pid) => !processExists(pid)),
        true,
      );
    } finally {
      forceKill(parent.pid);
      for (const pid of state?.pids ?? []) forceKill(pid);
      await childExit(parent);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("notifies termination observers without adding another process listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-observer-"));
    const readyPath = join(directory, "ready.json");
    const signalPath = join(directory, "signals.log");
    const parent = nativeSpawn(
      process.execPath,
      [SIGNAL_FORWARDING_FIXTURE, "async-observer", readyPath, signalPath],
      { stdio: "ignore" },
    );
    let state: SignalFixtureState | undefined;
    try {
      state = await signalFixtureState(readyPath);
      assert.equal(state.listenerCount - (state.baselineListenerCount ?? 0), 1);

      process.kill(parent.pid!, "SIGTERM");
      await childExit(parent);
      const lines = await signalLines(signalPath, 3);

      assert.equal(lines.includes("observer:SIGTERM"), true);
      assert.equal(lines.includes("0:SIGTERM"), true);
      assert.equal(lines.includes("1:SIGTERM"), true);
    } finally {
      forceKill(parent.pid);
      for (const pid of state?.pids ?? []) forceKill(pid);
      await childExit(parent);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not install or forward signals when disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-disabled-"));
    const readyPath = join(directory, "ready.json");
    const signalPath = join(directory, "signals.log");
    const parent = nativeSpawn(
      process.execPath,
      [SIGNAL_FORWARDING_FIXTURE, "async-disabled", readyPath, signalPath],
      { stdio: "ignore" },
    );
    let state: SignalFixtureState | undefined;
    try {
      state = await signalFixtureState(readyPath);
      assert.equal(state.listenerCount - (state.baselineListenerCount ?? 0), 0);

      process.kill(parent.pid!, "SIGTERM");
      await childExit(parent);
      await delay(50);

      assert.equal(existsSync(signalPath), false);
      assert.equal(processExists(state.pids[0]!), true);
    } finally {
      forceKill(parent.pid);
      for (const pid of state?.pids ?? []) forceKill(pid);
      await childExit(parent);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates shutdown failures and still runs later signal listeners", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-errors-"));
    const readyPath = join(directory, "ready.json");
    const signalPath = join(directory, "signals.log");
    const parent = nativeSpawn(
      process.execPath,
      [SIGNAL_FORWARDING_FIXTURE, "async-errors", readyPath, signalPath],
      { stdio: "ignore" },
    );
    let state: SignalFixtureState | undefined;
    try {
      state = await signalFixtureState(readyPath);
      assert.equal(state.listenerCount - (state.baselineListenerCount ?? 0), 2);

      process.kill(parent.pid!, "SIGTERM");
      await childExit(parent);
      const lines = await signalLines(signalPath, 2);

      assert.equal(lines.includes("parent-listener:SIGTERM"), true);
      assert.equal(lines.includes("2:SIGTERM"), true);
      assert.equal(lines.includes("unhandled-rejection"), false);
      assert.equal(processExists(state.pids[2]!), false);
    } finally {
      forceKill(parent.pid);
      for (const pid of state?.pids ?? []) forceKill(pid);
      await childExit(parent);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it(
    "snapshots during a foreground process-group SIGINT",
    { skip: process.platform === "win32" },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-sigint-"));
      const readyPath = join(directory, "ready.json");
      const signalPath = join(directory, "signals.log");
      const parent = nativeSpawn(
        process.execPath,
        [SIGNAL_FORWARDING_FIXTURE, "async-default", readyPath, signalPath],
        { stdio: ["ignore", "ignore", "pipe"], detached: true },
      );
      let stderr = "";
      parent.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      let state: SignalFixtureState | undefined;
      try {
        state = await signalFixtureState(readyPath);
        process.kill(-parent.pid!, "SIGINT");
        await childExit(parent);
        const lines = await signalLines(signalPath, 2);

        assert.deepEqual(lines.toSorted(), ["0:SIGINT", "1:SIGINT"]);
        assert.doesNotMatch(stderr, /failed to forward parent signal/);
        assert.equal(
          state.pids.every((pid) => !processExists(pid)),
          true,
        );
      } finally {
        forceKill(parent.pid);
        for (const pid of state?.pids ?? []) forceKill(pid);
        await childExit(parent);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it(
    "lets spawnSync inherit foreground process-group signals",
    { skip: process.platform === "win32" },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "dbx-tools-signals-sync-"));
      const readyPath = join(directory, "ready.json");
      const signalPath = join(directory, "signals.log");
      const parent = nativeSpawn(
        process.execPath,
        [SIGNAL_FORWARDING_FIXTURE, "sync-default", readyPath, signalPath],
        { stdio: "ignore", detached: true },
      );
      let state: SignalFixtureState | undefined;
      try {
        state = await signalFixtureState(readyPath);
        process.kill(-parent.pid!, "SIGTERM");
        await childExit(parent);
        assert.deepEqual(await signalLines(signalPath, 1), ["sync:SIGTERM"]);
      } finally {
        forceKill(parent.pid);
        for (const pid of state?.pids ?? []) forceKill(pid);
        await childExit(parent);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("process tree termination", () => {
  it("snapshots and gracefully stops a child and its descendants", async () => {
    const { child, started } = processTreeFixture("graceful");
    let descendantPid: number | undefined;
    try {
      descendantPid = await started;
      const shutdown = child.shutdown({
        terminateTimeout: 1_000,
        killTimeout: 1_000,
      });
      assert.equal(child.shutdown(), shutdown);
      await shutdown;
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
        await child.shutdown({
          terminateTimeout: 25,
          killTimeout: 1_000,
        });
        await child;

        assert.equal(child.signalCode, "SIGKILL");
        assert.equal(processExists(descendantPid), false);
        assert.deepEqual(gracefulSignals.toSorted(), ["child", "parent"]);
      } finally {
        forceKill(descendantPid);
        forceKill(child.pid);
        await child.catch(() => undefined);
      }
    },
  );

  it(
    "discovers and signals descendants created during termination polling",
    { skip: process.platform === "win32" },
    async () => {
      const { child, started, lateStarted } = processTreeFixture("late");
      let descendantPid: number | undefined;
      let latePid: number | undefined;
      try {
        descendantPid = await started;
        const shutdown = child.shutdown({
          terminateTimeout: 1_000,
          killTimeout: 1_000,
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
