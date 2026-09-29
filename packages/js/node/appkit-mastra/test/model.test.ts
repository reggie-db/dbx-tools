import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { servingApi } from "../src/model.ts";

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
});
