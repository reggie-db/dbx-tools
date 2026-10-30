import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFeedbackModes } from "../src/feedback-mode.ts";

describe("feedback mode", () => {
  it("publishes every available destination in auto mode", () => {
    assert.deepEqual(resolveFeedbackModes("auto", { genie: true, mlflow: true }), [
      "genie",
      "mlflow",
    ]);
    assert.deepEqual(resolveFeedbackModes("auto", { genie: false, mlflow: true }), ["mlflow"]);
    assert.deepEqual(resolveFeedbackModes(undefined, { genie: false, mlflow: false }), []);
  });

  it("fails an explicitly unavailable destination", () => {
    assert.throws(
      () => resolveFeedbackModes("genie", { genie: false, mlflow: true }),
      /feedbackMode "genie" is unavailable/,
    );
    assert.throws(
      () => resolveFeedbackModes("mlflow", { genie: true, mlflow: false }),
      /feedbackMode "mlflow" is unavailable/,
    );
  });
});
