import assert from "node:assert/strict";
import test from "node:test";
import { bundledModelCatalogIndex } from "@dbx-tools/dbx-model-catalog/snapshot";

import {
  estimateModelTokenPrice,
  modelCatalogPolicyRecordFor,
  modelCatalogRecordFor,
  modelCatalogUpdatedAt,
  modelLatencyFor,
  modelRankingsFor,
  modelRateLimitsFor,
  modelReasoningLevelsFor,
  modelTemperatureSupportFor,
} from "../src/metadata.ts";

test("returns catalog-owned records and fields without translating their shape", () => {
  const record = bundledModelCatalogIndex.records.find(
    (candidate) => candidate.latency && candidate.rankings.length > 0,
  );
  assert.ok(record);
  assert.equal(modelCatalogRecordFor(record.id), record);
  assert.equal(modelLatencyFor(record.id), record.latency);
  assert.equal(modelRankingsFor(record.id), record.rankings);
  assert.equal(modelRateLimitsFor(record.id), record.rate_limits ?? undefined);
  assert.equal(modelTemperatureSupportFor(record.id), record.capabilities.temperature ?? undefined);
});

test("resolves catalog aliases and live endpoint augmentation", () => {
  const record = bundledModelCatalogIndex.records.find((candidate) => candidate.aliases.length > 0);
  assert.ok(record);
  assert.equal(modelCatalogRecordFor(record.aliases[0]!)?.id, record.id);
  assert.equal(
    modelCatalogRecordFor({ name: "workspace-endpoint", catalog: record })?.id,
    record.id,
  );
});

test("inherits a prior direct record only for local newer-version policy", () => {
  const inherited = modelCatalogPolicyRecordFor("databricks-gpt-99-sol");
  assert.ok(inherited);
  assert.equal(inherited.family, "gpt-sol");
  assert.equal(modelCatalogRecordFor("databricks-gpt-99-sol"), undefined);
});

test("estimates cost from catalog-owned average price records", () => {
  const record = bundledModelCatalogIndex.records.find(
    (candidate) =>
      candidate.average_price.DBU?.rates.input !== undefined &&
      candidate.average_price.DBU?.rates.output !== undefined,
  );
  assert.ok(record);
  const estimate = estimateModelTokenPrice(record.id, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.ok(estimate);
  assert.equal(estimate.catalog, record);
  assert.equal(
    estimate.price.dbu,
    record.average_price.DBU!.rates.input! + record.average_price.DBU!.rates.output!,
  );
  assert.throws(() => estimateModelTokenPrice(record.id, { inputTokens: -1 }), RangeError);
});

test("uses catalog reasoning efforts before local family defaults", () => {
  const record = bundledModelCatalogIndex.records.find(
    (candidate) =>
      candidate.capabilities.reasoning?.supported === true &&
      Boolean(candidate.capabilities.reasoning.effort?.length),
  );
  assert.ok(record);
  assert.ok(modelReasoningLevelsFor(record.id).length > 0);
  assert.ok(modelReasoningLevelsFor("unknown-model").length > 0);
});

test("reports the direct catalog publication timestamp", () => {
  assert.equal(modelCatalogUpdatedAt(), bundledModelCatalogIndex.catalog.updated_at);
});
