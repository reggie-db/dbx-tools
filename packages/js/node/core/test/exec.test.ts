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
});
