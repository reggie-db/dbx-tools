import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AutomaticRouteDecisionSchema,
  AutomaticRouteObservationSchema,
  AutomaticRouteRequestSchema,
  EndpointCapabilitiesSchema,
  ModelMetadataSchema,
  ModelRateLimitsSchema,
  ModelStatusSchema,
  ResolveModelInputSchema,
  ResolveModelOptionsSchema,
  ResolvedModelSchema,
  ResolvedModelSelectionSchema,
  ServingEndpointSummarySchema,
} from "../src/contracts.ts";

describe("browser-safe model schemas", () => {
  it("validates endpoint capabilities and metadata", () => {
    assert.deepEqual(
      EndpointCapabilitiesSchema.parse({ chat: true, embedding: false, tools: true }),
      { chat: true, embedding: false, tools: true },
    );
    assert.doesNotThrow(() =>
      ModelMetadataSchema.parse({
        status: { deprecated: false },
        capabilities: {
          responses: true,
          imageInput: false,
          applyPatch: true,
          webSearch: false,
          reasoning: true,
          tools: true,
          structuredOutput: true,
          temperature: true,
        },
        rateLimits: {
          inputTokensPerMinute: 100,
          outputTokensPerMinute: null,
          queriesPerHour: 10,
        },
      }),
    );
  });

  it("enforces score and threshold bounds", () => {
    assert.doesNotThrow(() => ResolveModelOptionsSchema.parse({ threshold: 0.4 }));
    assert.throws(() => ResolveModelOptionsSchema.parse({ threshold: -0.1 }));
    assert.throws(() => ResolveModelOptionsSchema.parse({ threshold: 1.1 }));
    assert.doesNotThrow(() =>
      ResolvedModelSchema.parse({ modelId: "model", matched: true, score: 0 }),
    );
    assert.throws(() => ResolvedModelSchema.parse({ modelId: "model", matched: true, score: 2 }));
  });

  it("enforces nonnegative integer rate limits", () => {
    assert.doesNotThrow(() =>
      ModelRateLimitsSchema.parse({
        inputTokensPerMinute: null,
        outputTokensPerMinute: 0,
        queriesPerHour: 1,
      }),
    );
    assert.throws(() =>
      ModelRateLimitsSchema.parse({
        inputTokensPerMinute: -1,
        outputTokensPerMinute: 0,
        queriesPerHour: 1,
      }),
    );
    assert.throws(() =>
      ModelRateLimitsSchema.parse({
        inputTokensPerMinute: 1.5,
        outputTokensPerMinute: 0,
        queriesPerHour: 1,
      }),
    );
  });

  it("validates resolution intent and every selection source", () => {
    assert.deepEqual(
      ResolveModelInputSchema.parse({
        explicit: "grok 4",
        fallbacks: ["databricks-grok-4-7"],
      }).fallbacks,
      ["databricks-grok-4-7"],
    );
    for (const source of ["explicit", "fuzzy-match", "class", "fallback"]) {
      assert.doesNotThrow(() => ResolvedModelSelectionSchema.parse({ modelId: "model", source }));
    }
  });

  it("preserves defaults and nested reasoning validation", () => {
    assert.deepEqual(ModelStatusSchema.parse({}), { deprecated: false });
    assert.doesNotThrow(() =>
      ServingEndpointSummarySchema.parse({
        name: "databricks-gpt-test",
        reasoningEfforts: ["low", "high"],
      }),
    );
    assert.throws(() =>
      ServingEndpointSummarySchema.parse({
        name: "databricks-gpt-test",
        reasoningEfforts: ["impossible"],
      }),
    );
  });

  it("validates automatic route requests, decisions, and observations", () => {
    assert.doesNotThrow(() =>
      AutomaticRouteRequestSchema.parse({
        protocol: "openai-responses",
        currentRequest: "Refactor the authorization layer",
        recentContext: ["user: inspect the repository"],
        toolNames: ["apply_patch"],
        inputCharacters: 128,
        selectorTokens: 64,
        continuation: false,
        features: {
          tools: true,
          webSearch: false,
          imageInput: false,
          structuredOutput: false,
          applyPatch: true,
        },
        eligibleTiers: ["balanced", "thinking"],
      }),
    );
    assert.doesNotThrow(() =>
      AutomaticRouteDecisionSchema.parse({
        tier: "thinking",
        reasoningEffort: "xhigh",
        confidence: 0.9,
        reasonCode: "large_refactor",
      }),
    );
    assert.doesNotThrow(() =>
      AutomaticRouteObservationSchema.parse({
        selectedModel: "system.ai.example",
        tier: "thinking",
        reasoningEffort: "xhigh",
        confidence: 0.9,
        reasonCode: "large_refactor",
        source: "selector",
        degraded: false,
        selectorModel: "system.ai.openjev-qwen3.5-4b",
        selectorLatencyMs: 20,
      }),
    );
    assert.throws(() =>
      AutomaticRouteDecisionSchema.parse({
        tier: "thinking",
        reasoningEffort: "xhigh",
        confidence: 2,
        reasonCode: "large_refactor",
      }),
    );
  });
});
