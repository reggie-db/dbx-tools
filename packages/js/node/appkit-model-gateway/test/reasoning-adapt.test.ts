import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptInferenceReasoning, learnAndAdaptReasoningRetry } from "../src/reasoning-adapt.ts";

describe("reasoning adaptation", () => {
  it("proactively remaps unsupported wire tokens before upstream", () => {
    const adapted = adaptInferenceReasoning("databricks-grok-4-6", {
      model: "databricks-grok-4-6",
      reasoning: { effort: "none" },
    });
    assert.equal(adapted.changed, true);
    assert.equal(adapted.wireEffort, "medium");
    assert.deepEqual(adapted.body.reasoning, { effort: "medium" });
  });

  it("clamps Qwen requests to its published low-medium ladder", () => {
    for (const requested of ["high", "xhigh", "max", "none", null, "not-a-level"]) {
      const adapted = adaptInferenceReasoning("databricks-qwen-3-32b", {
        model: "databricks-qwen-3-32b",
        reasoning_effort: requested,
      });
      assert.equal(adapted.changed, true);
      assert.equal(adapted.wireEffort, "medium");
      assert.equal(adapted.body.reasoning_effort, "medium");
    }

    const absent = adaptInferenceReasoning("databricks-qwen-3-32b", {
      model: "databricks-qwen-3-32b",
    });
    assert.equal(absent.changed, false);
  });

  it("learns from a BAD_REQUEST body and retries once with a remapped effort", async () => {
    const error = {
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
    const response = new Response(JSON.stringify(error), { status: 400 });
    const retry = await learnAndAdaptReasoningRetry({
      model: "databricks-custom-reasoner",
      body: {
        model: "databricks-custom-reasoner",
        reasoning_effort: "none",
      },
      response,
      previousWireEffort: "none",
    });
    assert.ok(retry);
    assert.equal(retry.reasoning_effort, "medium");

    const noRetry = await learnAndAdaptReasoningRetry({
      model: "databricks-custom-reasoner",
      body: {
        model: "databricks-custom-reasoner",
        reasoning_effort: "none",
      },
      response: new Response(JSON.stringify(error), { status: 400 }),
      previousWireEffort: "medium",
    });
    assert.equal(noRetry, undefined);
  });

  it("removes reasoning and retries when the model rejects the feature", async () => {
    const retry = await learnAndAdaptReasoningRetry({
      model: "system.ai.qwen3-next-80b-a3b-instruct",
      body: {
        model: "system.ai.qwen3-next-80b-a3b-instruct",
        reasoning: { effort: "max" },
        reasoning_effort: "max",
        temperature: 1,
      },
      response: new Response(
        JSON.stringify({
          error_code: "INVALID_PARAMETER_VALUE",
          message: "This model does not support 'reasoning' for the Open Responses API.",
        }),
        { status: 400 },
      ),
      previousWireEffort: "high",
    });
    assert.deepEqual(retry, {
      model: "system.ai.qwen3-next-80b-a3b-instruct",
      temperature: 1,
    });
  });

  it("does not retry non-reasoning failures", async () => {
    const response = new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
    const retry = await learnAndAdaptReasoningRetry({
      model: "databricks-grok-4-6",
      body: { model: "databricks-grok-4-6", reasoning_effort: "high" },
      response,
      previousWireEffort: "high",
    });
    assert.equal(retry, undefined);
  });
});
