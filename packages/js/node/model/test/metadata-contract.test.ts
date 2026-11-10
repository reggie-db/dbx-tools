import assert from "node:assert/strict";
import { describe, it } from "node:test";

import capabilities from "../src/generated/model-capabilities.json" with { type: "json" };
import latency from "../src/generated/model-latency.json" with { type: "json" };
import rateLimits from "../src/generated/model-rate-limits.json" with { type: "json" };
import ratings from "../src/generated/model-ratings.json" with { type: "json" };
import reasoning from "../src/generated/model-reasoning.json" with { type: "json" };
import tokenPrices from "../src/generated/model-token-prices.json" with { type: "json" };
import modelParams from "../src/generated/modelparams-reasoning.json" with { type: "json" };
import modelsDev from "../src/generated/models-dev-capabilities.json" with { type: "json" };
import retired from "../src/generated/retired-models.json" with { type: "json" };
import {
  DocumentedReasoningCatalogueSchema,
  ModelCapabilitiesSnapshotSchema,
  ModelLatencyScoreSnapshotSchema,
  ModelParamsSnapshotSchema,
  ModelRateLimitsSnapshotSchema,
  ModelRatingsSnapshotSchema,
  ModelTokenPricesSnapshotSchema,
  ModelsDevSnapshotSchema,
  ReasoningModelsSnapshotSchema,
  RetiredModelsSnapshotSchema,
} from "../src/metadata-contract.ts";

describe("model metadata contracts", () => {
  const snapshots = [
    ["capabilities", ModelCapabilitiesSnapshotSchema, capabilities],
    ["latency", ModelLatencyScoreSnapshotSchema, latency],
    ["rate limits", ModelRateLimitsSnapshotSchema, rateLimits],
    ["ratings", ModelRatingsSnapshotSchema, ratings],
    ["reasoning", ReasoningModelsSnapshotSchema, reasoning],
    ["token prices", ModelTokenPricesSnapshotSchema, tokenPrices],
    ["modelparams", ModelParamsSnapshotSchema, modelParams],
    ["models.dev", ModelsDevSnapshotSchema, modelsDev],
    ["retired models", RetiredModelsSnapshotSchema, retired],
  ] as const;

  for (const [name, schema, snapshot] of snapshots) {
    it(`validates the committed ${name} snapshot without dropping fields`, () => {
      assert.deepEqual(schema.parse(snapshot), snapshot);
    });

    it(`rejects invalid generation timestamps in ${name}`, () => {
      for (const generatedAt of [-1, 0.5, "42"]) {
        assert.equal(schema.safeParse({ ...snapshot, generatedAt }).success, false);
      }
    });
  }

  it("requires all capability lists and validates each model identity", () => {
    assert.equal(
      ModelCapabilitiesSnapshotSchema.safeParse({
        generatedAt: 42,
        capabilities: { responses: [], imageInput: [], applyPatch: [] },
      }).success,
      false,
    );
    assert.equal(
      ModelCapabilitiesSnapshotSchema.safeParse({
        ...capabilities,
        capabilities: { ...capabilities.capabilities, webSearch: [false] },
      }).success,
      false,
    );
  });

  it("uses shared rate-limit and token-price schemas for catalogue entries", () => {
    assert.equal(
      ModelRateLimitsSnapshotSchema.safeParse({
        generatedAt: 42,
        catalogue: {
          models: {
            endpoint: {
              inputTokensPerMinute: -1,
              outputTokensPerMinute: null,
              queriesPerHour: null,
            },
          },
        },
      }).success,
      false,
    );
    assert.equal(
      ModelTokenPricesSnapshotSchema.safeParse({
        generatedAt: 42,
        catalogue: { models: { endpoint: [{ tier: "unknown" }] } },
      }).success,
      false,
    );
  });

  it("keeps documented labels distinct from normalized runtime reasoning ladders", () => {
    const catalogue = { models: { endpoint: ["xhigh", "provider-specific-effort"] } };
    assert.deepEqual(DocumentedReasoningCatalogueSchema.parse(catalogue), catalogue);
    assert.equal(
      DocumentedReasoningCatalogueSchema.safeParse({ models: { endpoint: [1] } }).success,
      false,
    );
    assert.equal(
      ModelParamsSnapshotSchema.safeParse({ generatedAt: 42, catalogue }).success,
      false,
    );
  });
});
