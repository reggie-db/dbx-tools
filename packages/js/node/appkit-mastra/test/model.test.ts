import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServingEndpointSummary } from "@dbx-tools/shared-model";

import { resolveDefaultModelId, RESPONSES_PROVIDER_OPTIONS, servingApi } from "../src/model.ts";

describe("Mastra serving API selection", () => {
  it("routes Responses-only models through the native Responses provider", () => {
    for (const modelId of [
      "databricks-gpt-6-astra",
      "databricks-gpt-5-6-sol",
      "databricks-gpt-5-5-pro",
      "databricks-gpt-5-4-mini",
      "databricks-gpt-5-3-codex",
    ]) {
      assert.equal(servingApi(modelId), "responses", modelId);
    }
  });

  it("keeps Chat Completions models on the chat provider", () => {
    for (const modelId of [
      "databricks-gpt-oss-120b",
      "databricks-claude-sonnet-4-6",
      "databricks-gemini-3-1-pro",
    ]) {
      assert.equal(servingApi(modelId), "chat", modelId);
    }
  });

  it("keeps Responses tool continuations stateless", () => {
    assert.deepEqual(RESPONSES_PROVIDER_OPTIONS, {
      openai: {
        store: false,
      },
    });
  });

  it("uses the highest-ranked live model when no default is configured", () => {
    const previous = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    const endpoints: ServingEndpointSummary[] = [
      { name: "databricks-claude-opus-4-7", task: "llm/v1/chat" },
      { name: "databricks-claude-opus-4-8", task: "llm/v1/chat" },
      { name: "databricks-gte-large-en", task: "llm/v1/embeddings" },
    ];
    try {
      assert.equal(resolveDefaultModelId({}, endpoints), "databricks-claude-opus-4-8");
    } finally {
      if (previous === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
      else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = previous;
    }
  });
});
