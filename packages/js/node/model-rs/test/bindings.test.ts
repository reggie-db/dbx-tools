import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatToolReasoningEffort,
  isResponsesOnly,
  modelFamily,
  rankModels,
  modelServingApi,
  ModelServingApi,
  ReasoningEffort,
  reasoningEffortNamesByFamily,
} from "../index.ts";

describe("model Rust bindings", () => {
  it("exposes inference protocol selection", () => {
    assert.equal(modelFamily("databricks-gpt-6-1-sol"), "gpt");
    assert.equal(modelServingApi("databricks-gpt-6-astra"), ModelServingApi.Responses);
    assert.equal(modelServingApi("databricks-gpt-oss-120b"), ModelServingApi.Chat);
    assert.equal(isResponsesOnly("databricks-gpt-5-6-sol"), true);
  });

  it("exposes Chat tool reasoning policy", () => {
    assert.equal(chatToolReasoningEffort("databricks-gpt-5-6-sol"), ReasoningEffort.None);
    assert.equal(chatToolReasoningEffort("databricks-gpt-5-5-pro"), undefined);
    assert.deepEqual(reasoningEffortNamesByFamily("databricks-gpt-6-1-sol"), [
      "low",
      "medium",
      "high",
    ]);
  });

  it("exposes catalogue ranking with version and variant preferences", () => {
    const endpoint = (name: string) => ({
      name,
      task: "llm/v1/chat",
      serviceNames: new Map<string, string>(),
      reasoningEfforts: [],
      status: { deprecated: false },
    });
    const ranked = rankModels(
      [
        endpoint("databricks-gpt-5-5-pro"),
        endpoint("databricks-gpt-5-6-luna"),
        endpoint("databricks-gpt-5-6-sol"),
      ],
      {
        search: "gpt",
        requiresTools: false,
        includeDeprecated: false,
      },
    );

    assert.deepEqual(
      ranked.map(({ endpoint: rankedEndpoint }) => rankedEndpoint.name),
      ["databricks-gpt-5-6-sol", "databricks-gpt-5-6-luna", "databricks-gpt-5-5-pro"],
    );
  });
});
