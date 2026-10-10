import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStaleMastraResumeError } from "../src/resume.ts";

describe("isStaleMastraResumeError", () => {
  it("matches Mastra resume ids and workflow status messages", () => {
    assert.equal(isStaleMastraResumeError({ id: "AGENT_RESUME_TOOL_CALL_NOT_SUSPENDED" }), true);
    assert.equal(isStaleMastraResumeError(new Error("This workflow run was not suspended")), true);
    assert.equal(
      isStaleMastraResumeError(
        new Error("No snapshot found for this workflow run: agent-workflow run-1"),
      ),
      true,
    );
    assert.equal(isStaleMastraResumeError(new Error("mastra-resume-already-settled")), true);
    assert.equal(isStaleMastraResumeError(new Error("model catalogue failed")), false);
    assert.equal(isStaleMastraResumeError(undefined), false);
  });
});
