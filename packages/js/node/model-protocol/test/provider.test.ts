import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText } from "ai";

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

  it("surfaces Chat Completions thinking as AI SDK reasoning", async () => {
    let received: Request | undefined;
    const model = createDatabricksLanguageModel({
      ...baseOptions,
      protocol: "chat",
      fetch: async (input, init) => {
        received = new Request(input, init);
        return Response.json({
          id: "chatcmpl_1",
          created: 1,
          model: baseOptions.modelId,
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "Checking the result." }],
                  },
                  { type: "text", text: "The result is valid." },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        });
      },
    });

    const result = await generateText({ model, prompt: "Check the result." });

    assert.equal(
      received?.url,
      "https://example.cloud.databricks.com/serving-endpoints/databricks-demo-model/invocations",
    );
    assert.ok(received);
    assert.equal(JSON.parse(await received.clone().text()).model, baseOptions.modelId);
    assert.equal(result.reasoningText, "Checking the result.");
    assert.equal(result.text, "The result is valid.");
  });
});
