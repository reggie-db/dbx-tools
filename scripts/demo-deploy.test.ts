import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { parseArgv } from "@dbx-tools/cli-args";
import { DemoDeployOptionsSchema } from "./demo-deploy.ts";

describe("demo deploy options", () => {
  it("validates by default", () => {
    assert.equal(parseArgv(DemoDeployOptionsSchema, []).validation, true);
  });

  it("accepts the common no-validation switch", () => {
    assert.equal(parseArgv(DemoDeployOptionsSchema, ["--no-validation"]).validation, false);
  });
});
