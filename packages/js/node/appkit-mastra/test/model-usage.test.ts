import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/core/request-context";

import { modelRoutePartData, modelUsagePartData } from "../src/model-usage.ts";
import { MASTRA_MODEL_ROUTE_KEY } from "../src/serving.ts";

describe("Mastra model usage events", () => {
  it("publishes routing, cumulative tokens, and estimated cost", () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_MODEL_ROUTE_KEY, {
      model: "databricks-gpt-5-4",
      selection: "smart-router",
      smartRouter: {
        selectedModel: "databricks-gpt-5-4",
        routeModel: "system.ai.gpt-5-4",
        harness: "codex",
        routerName: "task_v3",
        source: "router",
      },
    });

    assert.deepEqual(modelRoutePartData(requestContext, "run-1"), {
      runId: "run-1",
      model: "databricks-gpt-5-4",
      selection: "smart-router",
      smartRouter: {
        selectedModel: "databricks-gpt-5-4",
        routeModel: "system.ai.gpt-5-4",
        harness: "codex",
        routerName: "task_v3",
        source: "router",
      },
    });
    const usage = modelUsagePartData(
      requestContext,
      { inputTokens: 800, outputTokens: 200, totalTokens: 1_000 },
      "run-1",
    );
    assert.deepEqual(usage, {
        runId: "run-1",
        model: "databricks-gpt-5-4",
        selection: "smart-router",
        smartRouter: {
          selectedModel: "databricks-gpt-5-4",
          routeModel: "system.ai.gpt-5-4",
          harness: "codex",
          routerName: "task_v3",
          source: "router",
        },
        usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1_000 },
        estimatedCostDbu: 0.0714284,
    });
  });

  it("does not emit before a model route resolves", () => {
    assert.equal(modelUsagePartData(new RequestContext(), { totalTokens: 10 }), undefined);
  });
});
