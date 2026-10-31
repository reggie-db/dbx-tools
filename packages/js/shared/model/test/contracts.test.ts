import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EndpointCapabilitiesSchema,
  ModelLatencyScoreSchema,
  ModelMetadataSchema,
  ModelRatingSchema,
  ModelRateLimitsSchema,
  ModelTokenPriceSchema,
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
        latencyScore: {
          score: 1_100,
          measurements: {
            timeToFirstTokenMs: 100,
            outputTokensPerSecond: 100,
            successfulRunCount: 5,
            completionTokenCount: 100,
            measuredAt: "2026-10-30",
          },
        },
        rating: {
          score: 95.4,
          rankings: {
            text_style_control: {
              score: 1_484.9,
              lowerBound: 1_478.1,
              upperBound: 1_491.7,
              variance: 12.4,
              voteCount: 8_100,
              rank: 22,
              publishedAt: "2026-10-28",
            },
          },
        },
        rateLimits: {
          inputTokensPerMinute: 100,
          outputTokensPerMinute: null,
          queriesPerHour: 10,
        },
      }),
    );
  });

  it("validates normalized model latency scores", () => {
    const parsed = ModelLatencyScoreSchema.parse({
      score: 1_100,
      measurements: {
        timeToFirstTokenMs: 100,
        outputTokensPerSecond: 100,
        successfulRunCount: 5,
        completionTokenCount: 100,
        measuredAt: "2026-10-30T03:15:00-04:00",
      },
    });
    assert.equal(parsed.score, 1_100);
    assert.equal(parsed.measurements.measuredAt, "2026-10-30T07:15:00.000Z");
    assert.throws(() =>
      ModelLatencyScoreSchema.parse({
        score: -1,
        measurements: {
          timeToFirstTokenMs: 100,
          outputTokensPerSecond: 100,
          successfulRunCount: 5,
          completionTokenCount: 100,
          measuredAt: "2026-10-30",
        },
      }),
    );
  });

  it("validates sortable model ratings", () => {
    const parsed = ModelRatingSchema.parse({
      score: 92.4,
      rankings: {
        text: {
          score: 1_480,
          lowerBound: 1_470,
          upperBound: 1_490,
          voteCount: 8_000,
          rank: 25,
          publishedAt: "2026-10-28T03:15:00-04:00",
        },
        agent: {
          score: 0.21,
          lowerBound: 0.19,
          upperBound: 0.23,
          observationCount: 20_000,
          sessionCount: 1_500,
          rank: 4,
          publishedAt: Date.UTC(2026, 9, 28) / 1_000,
        },
        text_style_control: {
          score: 1_484.9,
          lowerBound: 1_478.1,
          upperBound: 1_491.7,
          variance: 12.4,
          voteCount: 8_100,
          rank: 22,
          publishedAt: "2026-10-28",
        },
      },
    });
    assert.equal(parsed.score, 92.4);
    assert.equal(parsed.rankings.text_style_control?.rank, 22);
    assert.equal(parsed.rankings.text_style_control?.publishedAt, "2026-10-28T00:00:00.000Z");
    assert.equal(parsed.rankings.text?.publishedAt, "2026-10-28T07:15:00.000Z");
    assert.equal(parsed.rankings.agent?.publishedAt, "2026-10-28T00:00:00.000Z");
    assert.throws(() =>
      ModelRatingSchema.parse({
        score: 92.4,
        rankings: {
          text_style_control: {
            score: 1_484.9,
            lowerBound: 1_478.1,
            upperBound: 1_491.7,
            variance: 12.4,
            voteCount: 8_100,
            rank: 22,
            publishedAt: "-7d",
          },
        },
      }),
    );
    assert.throws(() =>
      ModelRatingSchema.parse({
        score: 101,
        rankings: {
          agent: {
            score: 1,
            lowerBound: 0,
            upperBound: 2,
            observationCount: -1,
            sessionCount: 1,
            rank: 1,
            publishedAt: "2026-10-28",
          },
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

  it("validates Databricks token prices", () => {
    assert.doesNotThrow(() =>
      ModelTokenPriceSchema.parse({
        tier: "priority",
        condition: "long-context",
        inputDbuPerMillionTokens: 57.143,
        outputDbuPerMillionTokens: 214.286,
        cacheReadDbuPerMillionTokens: 2.857,
        cacheWriteDbuPerMillionTokens: 71.429,
        cacheWriteOneHourDbuPerMillionTokens: null,
        usdPerDbu: { aws: 0.07, azure: 0.08, gcp: 0.09 },
      }),
    );
    assert.throws(() =>
      ModelTokenPriceSchema.parse({
        tier: "priority",
        condition: "long-context",
        inputDbuPerMillionTokens: -1,
        outputDbuPerMillionTokens: null,
        cacheReadDbuPerMillionTokens: null,
        cacheWriteDbuPerMillionTokens: null,
        cacheWriteOneHourDbuPerMillionTokens: null,
        usdPerDbu: { aws: -1, azure: 0.08, gcp: 0.09 },
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
