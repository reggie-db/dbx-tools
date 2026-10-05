import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ModelCapabilities,
  ModelTarget,
  RequestedFeatures,
} from "@dbx-tools/shared-model-gateway";
import {
  isCodexOriginator,
  requestedFeatures,
  resolveRoute,
  UnsupportedGatewayFeatureError,
} from "../src/router.ts";

const BASE_CAPABILITIES: ModelCapabilities = {
  responses: false,
  openResponses: false,
  chat: true,
  anthropic: false,
  embeddings: false,
  aiGatewayCodex: false,
  tools: true,
  reasoning: true,
  streaming: true,
  parallelTools: true,
  customTools: false,
  structuredOutput: true,
  webSearch: false,
};

const NO_FEATURES: RequestedFeatures = {
  background: false,
  customTools: false,
  parallelTools: false,
  previousResponse: false,
  reasoning: false,
  storage: false,
  structuredOutput: false,
  tools: false,
  unsupportedOpenResponsesTools: false,
  webSearch: false,
};

describe("model gateway routing", () => {
  it("detects Codex anywhere in Originator without case sensitivity", () => {
    assert.equal(isCodexOriginator("OpenAI-CoDeX-CLI"), true);
    assert.equal(isCodexOriginator("openai-cli"), false);
  });

  it("uses the Unity Gateway Codex fast path for model-service slugs", () => {
    const target = fixtureTarget({
      responses: true,
      aiGatewayCodex: true,
      customTools: true,
    });
    const route = resolveRoute({
      clientProtocol: "openai-responses",
      requestedModel: `databricks/${target.modelServiceName}`,
      originator: "codex-cli",
      features: NO_FEATURES,
      target,
    });

    assert.equal(route.upstreamProtocol, "databricks-ai-gateway-codex");
    assert.equal(route.upstreamModel, target.modelServiceName);
    assert.equal(route.translateResponse, false);
  });

  it("keeps endpoint-name Responses requests on the serving fast path", () => {
    const target = fixtureTarget({ responses: true, customTools: true });
    const route = resolveRoute({
      clientProtocol: "openai-responses",
      requestedModel: target.id,
      originator: "codex",
      features: NO_FEATURES,
      target,
    });

    assert.equal(route.upstreamProtocol, "databricks-responses");
    assert.equal(route.upstreamModel, target.id);
  });

  it("uses AI Gateway before Open Responses for compatible non-OpenAI models", () => {
    const target = fixtureTarget(
      {
        openResponses: true,
        aiGatewayCodex: true,
      },
      "grok",
    );
    const route = resolveRoute({
      clientProtocol: "openai-responses",
      requestedModel: target.id,
      features: NO_FEATURES,
      target,
    });

    assert.equal(route.upstreamProtocol, "databricks-ai-gateway-codex");
  });

  it("routes Claude and Gemini through cross-provider Open Responses", () => {
    for (const family of ["claude", "gemini"]) {
      const target = fixtureTarget({ openResponses: true }, family);
      const route = resolveRoute({
        clientProtocol: "openai-responses",
        requestedModel: target.id,
        features: NO_FEATURES,
        target,
      });
      assert.equal(route.upstreamProtocol, "databricks-open-responses", family);
    }
  });

  it("uses native Anthropic Messages only for compatible models", () => {
    const direct = fixtureTarget({ anthropic: true }, "claude");
    assert.equal(
      resolveRoute({
        clientProtocol: "anthropic-messages",
        requestedModel: direct.id,
        features: NO_FEATURES,
        target: direct,
      }).upstreamProtocol,
      "databricks-anthropic",
    );

    const translated = fixtureTarget({ chat: false, responses: true }, "gpt");
    assert.equal(
      resolveRoute({
        clientProtocol: "anthropic-messages",
        requestedModel: translated.id,
        features: NO_FEATURES,
        target: translated,
      }).upstreamProtocol,
      "ai-sdk",
    );
  });

  it("routes embeddings only to embedding endpoints", () => {
    const target = fixtureTarget({
      chat: false,
      tools: false,
      reasoning: false,
      parallelTools: false,
      embeddings: true,
    });
    const route = resolveRoute({
      clientProtocol: "openai-embeddings",
      requestedModel: target.id,
      features: NO_FEATURES,
      target,
    });

    assert.equal(route.upstreamProtocol, "databricks-embeddings");
    assert.equal(route.translateRequest, false);
  });

  it("rejects stateful Responses features instead of dropping them", () => {
    const target = fixtureTarget({ responses: true });
    assert.throws(
      () =>
        resolveRoute({
          clientProtocol: "openai-responses",
          requestedModel: target.id,
          features: { ...NO_FEATURES, previousResponse: true },
          target,
        }),
      UnsupportedGatewayFeatureError,
    );
  });

  it("detects tools, structured output, and stateful options", () => {
    assert.deepEqual(
      requestedFeatures({
        tools: [{ type: "custom", name: "apply_patch" }],
        parallel_tool_calls: true,
        previous_response_id: "resp_1",
        store: true,
        background: true,
        text: { format: { type: "json_schema" } },
        reasoning: { effort: "high" },
      }),
      {
        background: true,
        customTools: true,
        parallelTools: true,
        previousResponse: true,
        reasoning: true,
        storage: true,
        structuredOutput: true,
        tools: true,
        unsupportedOpenResponsesTools: true,
        webSearch: false,
      },
    );
  });
});

function fixtureTarget(capabilities: Partial<ModelCapabilities>, family = "gpt"): ModelTarget {
  return {
    id: `databricks-${family}-test`,
    aliases: [`databricks-${family}-test`, `system.ai.${family}-test`],
    displayName: `${family} test`,
    family,
    modelServiceName: `system.ai.${family}-test`,
    capabilities: { ...BASE_CAPABILITIES, ...capabilities },
    reasoningEfforts: ["low", "medium", "high"],
  };
}
