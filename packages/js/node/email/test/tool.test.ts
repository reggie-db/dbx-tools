import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emailTool } from "../src/tool.ts";

describe("emailTool approval policy", () => {
  it("requires human approval by default", () => {
    assert.equal(emailTool().requireApproval, true);
  });

  it("passes a native conditional approval function through to Mastra", () => {
    const policy = async () => false;

    assert.equal(emailTool({ requireApproval: policy }).requireApproval, policy);
  });
});
