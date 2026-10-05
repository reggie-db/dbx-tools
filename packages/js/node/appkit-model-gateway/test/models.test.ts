import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelClass } from "@dbx-tools/shared-model";
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
  it("publishes Codex models with a chat class, sorted by family then name", () => {
    const targets = [
      target("gpt", { responses: true, openResponses: false, customTools: true }),
      target("claude", { anthropic: true }),
      target("gemini"),
      unnamed("Address Matching Embed"),
      unnamed("Agents Ann Default Final Langgraph Mcp"),
    ];
    const payload = listModelsPayload(targets, true);
    const codex = payload.models as Array<{ slug: string; priority: number }>;

    assert.deepEqual(
      codex.map((entry) => entry.slug),
      [
        "databricks/databricks-claude-test",
        "databricks/databricks-gemini-test",
        "databricks/system.ai.gpt-test",
      ],
    );
    assert.deepEqual(
      codex.map((entry) => entry.priority),
      [1, 2, 3],
    );
    assert.equal("object" in payload, false);
    assert.equal("data" in payload, false);
  });

  it("sorts OpenAI models by family then name, with no-family models last", () => {
    const payload = listModelsPayload(
      [
        named("Zeta", "gpt"),
        named("Beta", "claude"),
        named("Alpha", "gpt"),
        unnamed("Zed"),
        unnamed("Ada"),
      ],
      false,
    );

    assert.deepEqual(
      payload.data.map((entry) => entry.name),
      ["Beta", "Alpha", "Zeta", "Ada", "Zed"],
    );
  });

  it("omits deprecated models from both catalogue shapes", () => {
    const deprecated = {
      ...target("gpt"),
      endpoint: {
        name: "databricks-gpt-test",
        class: ModelClass.ChatBalanced,
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
      class: ModelClass.ChatBalanced,
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

function named(displayName: string, family: string): ModelTarget {
  return {
    ...target(family),
    id: displayName.toLowerCase(),
    aliases: [displayName.toLowerCase()],
    displayName,
    endpoint: {
      name: displayName.toLowerCase(),
      family,
      class: ModelClass.ChatBalanced,
      status: { deprecated: false },
    },
  };
}

function unnamed(displayName: string): ModelTarget {
  const id = displayName.toLowerCase().replaceAll(" ", "-");
  return {
    id,
    aliases: [id],
    displayName,
    endpoint: {
      name: id,
      status: { deprecated: false },
    },
    capabilities: CAPABILITIES,
    reasoningEfforts: [],
  };
}
