import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReasoningModels } from "../src/_metadata-generator.ts";
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

describe("reasoning documentation snapshot", () => {
  it("parses accepted effort ladders from the Query reasoning models table", () => {
    const snapshot = parseReasoningModels(
      `<table>
        <tr><th>Models</th><th>Reasoning model type</th><th>Details</th><th>Parameters</th></tr>
        <tr>
          <td><code>databricks-grok-4-6</code></td>
          <td>Reasoning only</td>
          <td>Always reasons.</td>
          <td>reasoning_effort accepts values of "low", "medium", "high", or "xhigh".</td>
        </tr>
        <tr>
          <td><code>databricks-gpt-6-astra</code></td>
          <td>Reasoning only</td>
          <td>Always reasons.</td>
          <td>Accepted values are low, medium, high, xhigh, and max. none is rejected.</td>
        </tr>
        <tr>
          <td><code>databricks-glm-5-2</code>, <code>databricks-kimi-k3</code></td>
          <td>Hybrid</td>
          <td>Varies.</td>
          <td>Accepted values vary by model. For GLM-5.2, this parameter accepts values of "high" or "max". For Kimi K3, this parameter accepts values of "low", "high", or "max".</td>
        </tr>
      </table>`,
      42,
    );
    assert.equal(snapshot.generatedAt, 42);
    assert.deepEqual(snapshot.catalogue.models["grok-4-6"], [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
    assert.deepEqual(snapshot.catalogue.models["gpt-6-astra"], [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
      ReasoningLevel.Max,
    ]);
    assert.deepEqual(snapshot.catalogue.models["glm-5-2"], [
      ReasoningLevel.High,
      ReasoningLevel.Max,
    ]);
    assert.deepEqual(snapshot.catalogue.models["kimi-3"], [
      ReasoningLevel.Low,
      ReasoningLevel.High,
      ReasoningLevel.Max,
    ]);
  });
});

describe("committed reasoning catalogue", () => {
  it("memoizes documented ladders and falls back to family defaults", () => {
    assert.equal(reasoningModelCatalogue(), reasoningModelCatalogue());
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
});

describe("learnReasoningLevelsFromError", () => {
  it("parses a nested BAD_REQUEST body and updates the learned cache", async () => {
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
    const learned = await learnReasoningLevelsFromError("databricks-grok-4-6", body);
    assert.deepEqual(learned, [
      ReasoningLevel.Low,
      ReasoningLevel.Medium,
      ReasoningLevel.High,
      ReasoningLevel.ExtraHigh,
    ]);
    assert.deepEqual(modelReasoningLevelsFor("databricks-grok-4-6"), learned);
  });
});
