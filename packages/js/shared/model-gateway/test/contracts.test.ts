import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ClientProtocolSchema,
  ModelCapabilityOverrideSchema,
  ModelTargetSchema,
  UpstreamProtocolSchema,
} from "../src/contracts.ts";
import {
  CodexModelListResponseSchema,
  EmbeddingResponseSchema,
  GatewayErrorResponseSchema,
  OpenAIModelListResponseSchema,
} from "../src/models.ts";

const CAPABILITIES = {
  responses: true,
  openResponses: false,
  chat: false,
  anthropic: false,
  embeddings: false,
  aiGatewayCodex: true,
  tools: true,
  reasoning: true,
  streaming: true,
  parallelTools: true,
  customTools: true,
  structuredOutput: true,
  webSearch: true,
};

describe("shared model-gateway schemas", () => {
  it("validates every protocol literal", () => {
    for (const protocol of [
      "openai-responses",
      "openai-chat",
      "anthropic-messages",
      "openai-embeddings",
    ]) {
      assert.doesNotThrow(() => ClientProtocolSchema.parse(protocol));
    }
    for (const protocol of [
      "databricks-ai-gateway-codex",
      "databricks-responses",
      "databricks-open-responses",
      "databricks-chat",
      "databricks-anthropic",
      "databricks-embeddings",
      "ai-sdk",
    ]) {
      assert.doesNotThrow(() => UpstreamProtocolSchema.parse(protocol));
    }
  });

  it("composes nested shared-model endpoint contracts", () => {
    assert.doesNotThrow(() =>
      ModelTargetSchema.parse({
        id: "databricks-gpt-test",
        aliases: ["gpt test"],
        displayName: "GPT Test",
        endpoint: {
          name: "databricks-gpt-test",
          reasoningEfforts: ["low", "high"],
        },
        capabilities: CAPABILITIES,
        reasoningEfforts: ["low", "high"],
      }),
    );
    assert.throws(() =>
      ModelTargetSchema.parse({
        id: "databricks-gpt-test",
        aliases: [],
        displayName: "GPT Test",
        capabilities: CAPABILITIES,
        reasoningEfforts: ["impossible"],
      }),
    );
  });

  it("accepts partial capability overrides", () => {
    assert.deepEqual(
      ModelCapabilityOverrideSchema.parse({
        model: "databricks-gpt-test",
        capabilities: { webSearch: false },
      }),
      {
        model: "databricks-gpt-test",
        capabilities: { webSearch: false },
      },
    );
  });

  it("validates OpenAI and Codex model catalogs", () => {
    assert.doesNotThrow(() =>
      OpenAIModelListResponseSchema.parse({
        object: "list",
        data: [
          {
            id: "databricks-gpt-test",
            object: "model",
            created: 0,
            owned_by: "databricks",
            name: "GPT Test",
            status: { deprecated: false },
            capabilities: {
              tools: true,
              reasoning: ["high"],
              responses: true,
              open_responses: false,
              anthropic: false,
              embeddings: false,
              ai_gateway_codex: true,
              streaming: true,
              web_search: true,
            },
          },
        ],
      }),
    );
    assert.doesNotThrow(() =>
      CodexModelListResponseSchema.parse({
        models: [
          {
            slug: "databricks/system.ai.gpt-test",
            display_name: "GPT Test",
            description: "Test model",
            base_instructions: "Act as a coding agent.",
            status: { deprecated: false },
            supported_reasoning_levels: [{ effort: "high", description: "High" }],
            default_reasoning_level: "high",
            shell_type: "unified_exec",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            availability_nux: null,
            upgrade: null,
            support_verbosity: false,
            default_verbosity: null,
            apply_patch_tool_type: "freeform",
            truncation_policy: { mode: "tokens", limit: 128000 },
            context_window: null,
            experimental_supported_tools: [],
            input_modalities: ["text"],
            web_search_tool_type: "text",
            supports_search_tool: true,
            supports_image_detail_original: false,
          },
        ],
      }),
    );
  });

  it("validates embeddings and both error envelopes", () => {
    assert.doesNotThrow(() =>
      EmbeddingResponseSchema.parse({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        model: "databricks-gte-large-en",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    assert.doesNotThrow(() =>
      GatewayErrorResponseSchema.parse({
        error: { message: "bad request", type: "invalid_request_error", code: 400 },
      }),
    );
    assert.doesNotThrow(() =>
      GatewayErrorResponseSchema.parse({
        type: "error",
        error: { type: "invalid_request_error", message: "bad request" },
      }),
    );
  });
});
