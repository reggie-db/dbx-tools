import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureTaskCommand, taskCommandSucceeds } from "../src/_task-command.ts";

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
});
