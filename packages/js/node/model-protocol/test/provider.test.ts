import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDatabricksLanguageModel } from "../src/provider.ts";

const baseOptions = {
  modelId: "databricks-demo-model",
  host: "https://example.cloud.databricks.com/",
  headers: { authorization: "Bearer token" },
} as const;

describe("Databricks AI SDK provider", () => {
  it("constructs ProviderV4 models for every supported protocol", () => {
    const expectedProviders = {
      chat: "openai.chat",
      responses: "openai.responses",
      anthropic: "anthropic",
    } as const;

    for (const protocol of ["chat", "responses", "anthropic"] as const) {
      const model = createDatabricksLanguageModel({ ...baseOptions, protocol });
      assert.equal(model.modelId, baseOptions.modelId);
      assert.equal(model.provider, expectedProviders[protocol]);
      assert.equal(model.specificationVersion, "v4");
    }
  });

  it("requires a bearer token for Anthropic providers", () => {
    assert.throws(
      () =>
        createDatabricksLanguageModel({
          ...baseOptions,
          protocol: "anthropic",
          headers: {},
        }),
      /did not produce a bearer token/,
    );
  });

  it("uses a custom provider namespace", () => {
    const model = createDatabricksLanguageModel({
      ...baseOptions,
      protocol: "responses",
      providerName: "databricks",
    });
    assert.equal(model.provider, "databricks.responses");
  });
});
