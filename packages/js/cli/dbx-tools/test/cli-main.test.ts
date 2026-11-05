import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { formatCliError, runCliMain } from "../src/_cli-main.ts";

describe("CLI process boundary", () => {
  it("prints only the error message by default", () => {
    assert.equal(
      formatCliError(new Error("service installation failed"), false),
      "Error: service installation failed",
    );
  });

  it("includes the stack trace for debug output", () => {
    const error = new Error("service installation failed");
    error.stack = [
      "Error: service installation failed",
      "    at installService (/workspace/src/install.ts:10:5)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");

    assert.equal(
      formatCliError(error, true),
      [
        "Error: service installation failed",
        "    at installService (/workspace/src/install.ts:10:5)",
      ].join("\n"),
    );
  });

  it("renders validation failures by field instead of as JSON", () => {
    const schema = z.object({ listen: z.object({ port: z.number().max(65_535) }) });
    const result = schema.safeParse({ listen: { port: 70_000 } });
    assert.equal(result.success, false);
    if (result.success) return;

    assert.equal(
      formatCliError(result.error, false),
      "Error: listen.port: Too big: expected number to be <=65535",
    );
  });

  it("sets a failing exit code without terminating the process", async () => {
    const messages: string[] = [];
    const exitCodes: number[] = [];
    await runCliMain(
      () => {
        throw new Error("service installation failed");
      },
      messages.push.bind(messages),
      exitCodes.push.bind(exitCodes),
    );

    assert.deepEqual(messages, ["Error: service installation failed"]);
    assert.deepEqual(exitCodes, [1]);
  });
});
