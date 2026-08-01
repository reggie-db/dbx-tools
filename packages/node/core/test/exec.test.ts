import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exec } from "../index.ts";

const MISSING_COMMAND = `dbx-tools-missing-command-${process.pid}`;
const QUIET_STDIO = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const;

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
