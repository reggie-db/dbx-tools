import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/core/request-context";

import { modelUsagePartData } from "../src/model-usage.ts";
import { MASTRA_MODEL_ROUTE_KEY } from "../src/serving.ts";

describe("Mastra model usage events", () => {
  it("publishes routing, cumulative tokens, and estimated cost", () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_MODEL_ROUTE_KEY, {
      model: "databricks-gpt-test",
      selection: "smart-router",
      costPerMillionTokens: 2.5,
      smartRouter: {
        selectedModel: "databricks-gpt-test",
        routeModel: "system.ai.gpt-test",
        harness: "codex",
        routerName: "task_v3",
        source: "router",
      },
    });

    assert.deepEqual(
      modelUsagePartData(
        requestContext,
        { inputTokens: 800, outputTokens: 200, totalTokens: 1_000 },
        "run-1",
      ),
      {
        runId: "run-1",
        model: "databricks-gpt-test",
        selection: "smart-router",
        smartRouter: {
          selectedModel: "databricks-gpt-test",
          routeModel: "system.ai.gpt-test",
          harness: "codex",
          routerName: "task_v3",
          source: "router",
        },
        usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1_000 },
        costPerMillionTokens: 2.5,
        estimatedCostUsd: 0.0025,
      },
    );
  });

  it("does not emit before a model route resolves", () => {
    assert.equal(modelUsagePartData(new RequestContext(), { totalTokens: 10 }), undefined);
  });
});
