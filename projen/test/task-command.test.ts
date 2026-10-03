import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureTaskCommand,
  probeTaskCommand,
  runLoggedTaskCommand,
  taskCommandSucceeds,
} from "../src/_task-command.ts";

describe("Projen task commands", () => {
  it("captures trimmed stdout", () => {
    assert.equal(
      captureTaskCommand(process.cwd(), process.execPath, ["-e", 'console.log("value")']),
      "value",
    );
  });

  it("distinguishes optional probes from checked commands", () => {
    const args = ["-e", "process.exit(7)"];
    assert.equal(captureTaskCommand(process.cwd(), process.execPath, args), "");
    assert.throws(() => captureTaskCommand(process.cwd(), process.execPath, args, { check: true }));
    assert.equal(taskCommandSucceeds(process.cwd(), process.execPath, args), false);
  });

  it("distinguishes failed probes from successful empty output", () => {
    assert.equal(
      probeTaskCommand(process.cwd(), process.execPath, ["-e", "process.exit(7)"]),
      undefined,
    );
    assert.equal(probeTaskCommand(process.cwd(), process.execPath, ["-e", "process.exit(0)"]), "");
  });

  it("routes captured stdout and stderr through one logger", () => {
    const lines: string[] = [];
    runLoggedTaskCommand(
      process.cwd(),
      process.execPath,
      ["-e", 'console.log("out"); console.error("err")'],
      { onLine: (line) => lines.push(line) },
    );
    assert.deepEqual(lines, ["out", "err"]);
  });
});
