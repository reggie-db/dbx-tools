import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelClass, type ServingEndpointSummary } from "@dbx-tools/shared-model";

import {
  fallbackAutomaticRouteDecision,
  nearestReasoningEffort,
  resolveAutomaticModel,
} from "../src/automatic-routing.ts";

describe("automatic model routing policy", () => {
  it("resolves the selected tier through the existing model ranking owner", () => {
    const resolved = resolveAutomaticModel(
      [endpoint("fast", ModelClass.ChatFast), endpoint("thinking", ModelClass.ChatThinking)],
      {
        tier: "thinking",
        reasoningEffort: "xhigh",
        confidence: 0.9,
        reasonCode: "large_refactor",
      },
    );

    assert.equal(resolved.endpoint.name, "thinking");
    assert.equal(resolved.tier, "thinking");
    assert.equal(resolved.reasoningEffort, "high");
  });

  it("requires exact explicit reasoning but maps automatic reasoning to the nearest ladder", () => {
    const candidate = endpoint("balanced", ModelClass.ChatBalanced, ["low", "high"]);
    assert.equal(nearestReasoningEffort("medium", candidate.reasoningEfforts ?? []), "high");
    assert.throws(
      () =>
        resolveAutomaticModel(
          [candidate],
          {
            tier: "balanced",
            reasoningEffort: "medium",
            confidence: 1,
            reasonCode: "routine_qa",
          },
          { explicitReasoningEffort: "medium" },
        ),
      /No compatible live model/,
    );
  });

  it("uses balanced deterministic fallback when that tier is eligible", () => {
    assert.deepEqual(
      fallbackAutomaticRouteDecision({ eligibleTiers: ["fast", "balanced", "thinking"] }),
      {
        tier: "balanced",
        reasoningEffort: "medium",
        confidence: 0,
        reasonCode: "ambiguous",
      },
    );
  });

  it("prefers lower cost and then open-weight candidates within the selected tier", () => {
    const expensive = endpoint("databricks-claude-sonnet-4-6", ModelClass.ChatBalanced);
    expensive.profile = { quality: 2, cost: 8 };
    const cheap = endpoint("databricks-gpt-oss-120b", ModelClass.ChatBalanced);
    cheap.profile = { quality: 2, cost: 2 };
    assert.equal(
      resolveAutomaticModel(
        [expensive, cheap],
        {
          tier: "balanced",
          reasoningEffort: "medium",
          confidence: 1,
          reasonCode: "routine_qa",
        },
        { preferCostEfficientModels: true },
      ).endpoint.name,
      cheap.name,
    );

    const unpricedOpen = endpoint("databricks-qwen-3-32b", ModelClass.ChatBalanced);
    assert.equal(
      resolveAutomaticModel(
        [expensive, unpricedOpen],
        {
          tier: "balanced",
          reasoningEffort: "medium",
          confidence: 1,
          reasonCode: "routine_qa",
        },
        { preferCostEfficientModels: true },
      ).endpoint.name,
      unpricedOpen.name,
    );
  });
});

function endpoint(
  name: string,
  modelClass: ServingEndpointSummary["class"],
  reasoningEfforts: ServingEndpointSummary["reasoningEfforts"] = ["low", "high"],
): ServingEndpointSummary {
  return {
    name,
    task: "llm/v1/chat",
    class: modelClass,
    profile: {
      quality:
        modelClass === ModelClass.ChatThinking ? 3 : modelClass === ModelClass.ChatBalanced ? 2 : 1,
    },
    supportsTools: true,
    reasoningEfforts,
    status: { deprecated: false },
  };
}
