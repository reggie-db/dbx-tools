import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundledModelCatalogIndex } from "@dbx-tools/dbx-model-catalog/snapshot";

import {
  EndpointCapabilitiesSchema,
  ModelQuerySchema,
  ResolveModelInputSchema,
  ResolveModelOptionsSchema,
  ResolvedModelSchema,
  ResolvedModelSelectionSchema,
  ServingEndpointSummarySchema,
} from "../src/contracts.ts";

describe("browser-safe model schemas", () => {
  it("validates endpoint capabilities and direct catalog augmentation", () => {
    assert.deepEqual(
      EndpointCapabilitiesSchema.parse({ chat: true, embedding: false, tools: true }),
      { chat: true, embedding: false, tools: true },
    );
    const catalog = bundledModelCatalogIndex.records[0];
    assert.ok(catalog);
    assert.deepEqual(
      ServingEndpointSummarySchema.parse({ name: "workspace-endpoint", catalog }).catalog,
      catalog,
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

  it("reuses catalogue filters for model resolution without accepting query-only fields", () => {
    for (const field of ["threshold", "requiresTools", "modelSource"] as const) {
      assert.equal(ResolveModelOptionsSchema.shape[field], ModelQuerySchema.shape[field]);
      assert.equal(ResolveModelInputSchema.shape[field], ModelQuerySchema.shape[field]);
    }
    for (const field of ["requiresStructuredOutput", "optimizeFor", "modelClass"] as const) {
      assert.equal(ResolveModelInputSchema.shape[field], ModelQuerySchema.shape[field]);
    }
    assert.deepEqual(ResolveModelOptionsSchema.parse({ search: "chat", limit: 5 }), {});
    assert.deepEqual(ResolveModelInputSchema.parse({ search: "chat", limit: 5 }), {});
  });

  it("validates resolution intent and every selection source", () => {
    assert.deepEqual(
      ResolveModelInputSchema.parse({
        explicit: "grok 4",
        fallbacks: ["databricks-grok-4-7"],
      }).fallbacks,
      ["databricks-grok-4-7"],
    );
    for (const source of ["explicit", "fuzzy-match", "unmatched", "class", "fallback"]) {
      assert.doesNotThrow(() => ResolvedModelSelectionSchema.parse({ modelId: "model", source }));
    }
  });

  it("validates nested reasoning efforts", () => {
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
