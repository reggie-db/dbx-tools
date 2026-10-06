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
  it("publishes Codex models with a chat class, sorted by major family then display name", () => {
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
        "databricks/system.ai.gpt-test",
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

  it("publishes discovered web search on OpenAI and Codex catalogues", () => {
    const gpt = target("gpt", { webSearch: true });
    const gemini = target("gemini", { webSearch: false });
    const openAiPayload = listModelsPayload([gpt, gemini], false);
    const codexPayload = listModelsPayload([gpt, gemini], true);

    assert.equal(openAiPayload.data[0]?.capabilities.web_search, true);
    assert.equal(openAiPayload.data[1]?.capabilities.web_search, false);
    assert.equal(codexPayload.models[0]?.supports_search_tool, true);
    assert.equal(codexPayload.models[1]?.supports_search_tool, false);
  });

  it("sorts OpenAI models as major-provider families, other chat, then embeddings", () => {
    const payload = listModelsPayload(
      [
        embedding("Test Pt Disabled Legacy It", "bge"),
        named("GPT Zeta", "gpt"),
        unnamed("Zed"),
        unnamed("Ben Test GPT OSS 1"),
        unnamed("AI Query E 2 E Pt Chat"),
        embedding("GTE Large (En)", "gte"),
        named("Veo 3.1 Generate", "gemini"),
        named("Claude Beta", "claude"),
        unnamed("Ada"),
        named("GPT Alpha", "gpt"),
      ],
      false,
    );

    assert.deepEqual(
      payload.data.map((entry) => entry.name),
      [
        "Claude Beta",
        "GPT Alpha",
        "GPT Zeta",
        "Veo 3.1 Generate",
        "Ada",
        "AI Query E 2 E Pt Chat",
        "Ben Test GPT OSS 1",
        "Zed",
        "GTE Large (En)",
        "Test Pt Disabled Legacy It",
      ],
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

function embedding(displayName: string, family: string): ModelTarget {
  const id = displayName.toLowerCase().replaceAll(" ", "_");
  return {
    ...unnamed(displayName),
    id,
    family,
    capabilities: { ...CAPABILITIES, embeddings: true, chat: false, tools: false },
    endpoint: {
      name: id,
      family,
      task: "llm/v1/embeddings",
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
