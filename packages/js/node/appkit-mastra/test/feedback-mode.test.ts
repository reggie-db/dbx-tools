import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFeedbackMode } from "../src/feedback-mode.ts";

describe("feedback mode", () => {
  it("prefers Genie, then MLflow, then none in auto mode", () => {
    assert.equal(resolveFeedbackMode("auto", { genie: true, mlflow: true }), "genie");
    assert.equal(resolveFeedbackMode("auto", { genie: false, mlflow: true }), "mlflow");
    assert.equal(resolveFeedbackMode(undefined, { genie: false, mlflow: false }), "none");
  });

  it("fails an explicitly unavailable destination", () => {
    assert.throws(
      () => resolveFeedbackMode("genie", { genie: false, mlflow: true }),
      /feedbackMode "genie" is unavailable/,
    );
    assert.throws(
      () => resolveFeedbackMode("mlflow", { genie: true, mlflow: false }),
      /feedbackMode "mlflow" is unavailable/,
    );
  });
});
