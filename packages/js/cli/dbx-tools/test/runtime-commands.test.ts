import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram } from "../src/cli.ts";

describe("runtime commands", () => {
  it("registers lazy proxy commands without executing them", () => {
    const help = buildProgram().helpInformation();

    assert.match(help, /genie/);
    assert.match(help, /model-gateway/);
    assert.match(help, /lakebase-proxy/);
  });
});
