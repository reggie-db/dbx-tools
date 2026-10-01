import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram } from "../src/cli.ts";

describe("release binaries", () => {
  it("registers generated commands without executing them", () => {
    const help = buildProgram().helpInformation();

    assert.match(help, /model-proxy/);
    assert.match(help, /lakebase-proxy/);
  });
});
