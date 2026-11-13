import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  learnReasoningLevelsFromError,
  modelReasoningLevelsFor,
  reasoningModelCatalogue,
} from "../src/metadata.ts";
import {
  adaptRequestReasoning,
  defaultReasoningLevels,
  formatReasoning,
  parseReasoning,
  parseReasoningLevels,
  ReasoningLevel,
  remapReasoning,
} from "../src/reasoning-translation.ts";

describe("parseReasoning", () => {
  it("maps exact, alias, and fuzzy effort labels onto the generic ladder", () => {
    assert.equal(parseReasoning("low"), ReasoningLevel.Low);
    assert.equal(parseReasoning("MED"), ReasoningLevel.Medium);
    assert.equal(parseReasoning("xhigh"), ReasoningLevel.ExtraHigh);
    assert.equal(parseReasoning("extra high"), ReasoningLevel.ExtraHigh);
    assert.equal(parseReasoning("ultra"), ReasoningLevel.ExtraHigh);
    assert.equal(parseReasoning("none"), ReasoningLevel.Low);
    assert.equal(parseReasoning("minimal"), ReasoningLevel.Low);
    assert.equal(parseReasoning("max"), ReasoningLevel.Max);
    assert.equal(formatReasoning(ReasoningLevel.ExtraHigh), "xhigh");
  });

  it("returns undefined for empty or unknown labels", () => {
    assert.equal(parseReasoning(""), undefined);
    assert.equal(parseReasoning("not-an-effort"), undefined);
    assert.equal(parseReasoning(undefined), undefined);
  });
});

describe("parseReasoningLevels", () => {
  it("unwraps nested Databricks error envelopes without caching", () => {
    const body = {
      error_code: "BAD_REQUEST",
      message: JSON.stringify({
        message: JSON.stringify({
          error: {
            code: "unsupported_value",
            message:
              "Unsupported value: 'none' is not supported with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
            param: "reasoning_effort",
            type: "invalid_request_error",
          },
        }),
      }),
    };
    assert.deepEqual(parseReasoningLevels(body), [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
    assert.deepEqual(parseReasoningLevels(JSON.stringify(body)), [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
  });

  it("returns an empty list when no supported-values sentence is present", () => {
    assert.deepEqual(parseReasoningLevels({ message: "rate limited" }), []);
  });
});

describe("committed reasoning catalogue", () => {
  it("uses catalog ladders and falls back to family defaults", () => {
    assert.ok(Object.keys(reasoningModelCatalogue()).length > 0);
    assert.deepEqual(modelReasoningLevelsFor("databricks-grok-4-6"), [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
    assert.deepEqual(
      modelReasoningLevelsFor("system.ai.grok-4-7"),
      defaultReasoningLevels("grok-4-7"),
    );
  });
});

describe("remapReasoning and adaptRequestReasoning", () => {
  it("remaps onto the nearest supported level and formats wire tokens", () => {
    assert.equal(
      remapReasoning("max", [
        ReasoningLevel.Low,
        ReasoningLevel.Medium,
        ReasoningLevel.High,
        ReasoningLevel.ExtraHigh,
      ]),
      ReasoningLevel.ExtraHigh,
    );

    const adapted = adaptRequestReasoning(
      {
        model: "databricks-grok-4-6",
        reasoning_effort: "none",
        reasoning: { effort: "none" },
      },
      [ReasoningLevel.Low, ReasoningLevel.Medium, ReasoningLevel.High, ReasoningLevel.ExtraHigh],
    );
    assert.equal(adapted.changed, true);
    assert.equal(adapted.wireEffort, "medium");
    assert.equal(adapted.body.reasoning_effort, "medium");
    assert.deepEqual(adapted.body.reasoning, { effort: "medium" });
  });

  it("maps none onto the supported level closest to medium", () => {
    assert.equal(
      remapReasoning("none", [
        ReasoningLevel.Low,
        ReasoningLevel.Medium,
        ReasoningLevel.High,
        ReasoningLevel.ExtraHigh,
      ]),
      ReasoningLevel.Medium,
    );
    assert.equal(
      remapReasoning("none", [ReasoningLevel.High, ReasoningLevel.Max]),
      ReasoningLevel.High,
    );
    assert.equal(
      remapReasoning("off", [ReasoningLevel.Low, ReasoningLevel.High, ReasoningLevel.Max]),
      ReasoningLevel.High,
    );
  });

  it("maps Qwen overflow and invalid explicit values onto medium", () => {
    const qwenLevels = [ReasoningLevel.Low, ReasoningLevel.Medium];
    for (const requested of ["high", "xhigh", "max", "none", null, "not-a-level"]) {
      assert.equal(remapReasoning(requested, qwenLevels), ReasoningLevel.Medium);
    }

    const nullEffort = adaptRequestReasoning(
      { reasoning_effort: null, reasoning: { effort: null } },
      qwenLevels,
    );
    assert.equal(nullEffort.changed, true);
    assert.equal(nullEffort.body.reasoning_effort, "medium");
    assert.deepEqual(nullEffort.body.reasoning, { effort: "medium" });

    const absentEffort = adaptRequestReasoning({ model: "qwen-3-32b" }, qwenLevels);
    assert.equal(absentEffort.changed, false);
    assert.deepEqual(absentEffort.body, { model: "qwen-3-32b" });
  });
});

describe("learnReasoningLevelsFromError", () => {
  it("prefers modelparams.dev levels over an error-derived ladder", async () => {
    const body = {
      error: {
        message: "Unsupported reasoning_effort. Supported values are: 'low' and 'high'.",
      },
    };
    const learned = await learnReasoningLevelsFromError("databricks-grok-4-7", body);
    assert.deepEqual(learned, [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
    assert.deepEqual(modelReasoningLevelsFor("databricks-grok-4-7"), learned);
  });

  it("parses a nested BAD_REQUEST body for an unpublished custom model", async () => {
    const body = {
      error_code: "BAD_REQUEST",
      message: JSON.stringify({
        message: JSON.stringify({
          error: {
            code: "unsupported_value",
            message:
              "Unsupported value: 'none' is not supported with this model. Supported values are: 'low' and 'high'.",
            param: "reasoning_effort",
            type: "invalid_request_error",
          },
        }),
      }),
    };
    const model = "databricks-grok-99-custom";
    const learned = await learnReasoningLevelsFromError(model, body);
    assert.deepEqual(learned, [ReasoningLevel.Low, ReasoningLevel.High]);
    assert.deepEqual(modelReasoningLevelsFor(model), learned);
  });
});
