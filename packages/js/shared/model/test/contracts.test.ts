import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EndpointCapabilitiesSchema,
  ModelMetadataSchema,
  ModelRateLimitsSchema,
  ModelStatusSchema,
  ResolveModelInputSchema,
  ResolveModelOptionsSchema,
  ResolvedModelSchema,
  ResolvedModelSelectionSchema,
  ServingEndpointSummarySchema,
} from "../src/model.ts";

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
});
