import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelCapabilities, ModelTarget } from "@dbx-tools/shared-model-gateway";

import { listModelsPayload } from "../src/models.ts";

const CAPABILITIES: ModelCapabilities = {
  responses: false,
  openResponses: true,
  chat: true,
  anthropic: false,
  embeddings: false,
  aiGatewayCodex: true,
  tools: true,
  reasoning: true,
  streaming: true,
  parallelTools: true,
  customTools: false,
  structuredOutput: true,
  webSearch: false,
};

describe("model gateway catalogue", () => {
  it("publishes every Codex-satisfiable provider family", () => {
    const targets = [
      target("gpt", { responses: true, openResponses: false, customTools: true }),
      target("claude", { anthropic: true }),
      target("gemini"),
    ];
    const payload = listModelsPayload(targets, true);
    const codex = payload.models as Array<{ slug: string; priority: number }>;

    assert.deepEqual(
      codex.map((entry) => entry.slug),
      [
        "databricks/system.ai.gpt-test",
        "databricks/databricks-claude-test",
        "databricks/databricks-gemini-test",
      ],
    );
    assert.deepEqual(
      codex.map((entry) => entry.priority),
      [1, 2, 3],
    );
    assert.equal("object" in payload, false);
    assert.equal("data" in payload, false);
  });

  it("omits deprecated models from both catalogue shapes", () => {
    const deprecated = {
      ...target("gpt"),
      endpoint: {
        name: "databricks-gpt-test",
        status: { deprecated: true },
      },
    } satisfies ModelTarget;
    const openAiPayload = listModelsPayload([deprecated], false);
    const codexPayload = listModelsPayload([deprecated], true);

    assert.deepEqual(openAiPayload.data, []);
    assert.deepEqual(codexPayload.models, []);
  });
});

function target(family: string, capabilities: Partial<ModelCapabilities> = {}): ModelTarget {
  return {
    id: `databricks-${family}-test`,
    aliases: [`databricks-${family}-test`, `system.ai.${family}-test`],
    displayName: `${family} test`,
    family,
    modelServiceName: `system.ai.${family}-test`,
    endpoint: {
      name: `databricks-${family}-test`,
      family,
      status: { deprecated: false },
    },
    capabilities: {
      ...CAPABILITIES,
      ...(family === "claude" || family === "gemini" ? { aiGatewayCodex: false } : {}),
      ...capabilities,
    },
    reasoningEfforts: ["medium"],
  };
}
