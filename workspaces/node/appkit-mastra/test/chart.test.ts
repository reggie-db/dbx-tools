import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { chartPlanSchema } from "../src/chart";

/**
 * Walk every nested schema node, yielding each object so a test can
 * assert on keywords wherever they appear in the tree.
 */
function* nodes(schema: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(schema)) {
    for (const item of schema) yield* nodes(item);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  yield record;
  for (const value of Object.values(record)) yield* nodes(value);
}

describe("chart plan JSON schema", () => {
  // Databricks' Gemini serving endpoints validate `response_json_schema`
  // and reject JSON Schema 2020-12 `prefixItems` with "schema at
  // properties.series.items.properties.data.items.anyOf.2.items must be a
  // boolean or an object". Zod emits `prefixItems` for `z.tuple`, so the
  // scatter `[x, y]` point must stay a length-constrained number array.
  it("emits no prefixItems, so Gemini accepts it as a response schema", () => {
    const jsonSchema = z.toJSONSchema(chartPlanSchema);
    const offenders = [...nodes(jsonSchema)].filter((node) => "prefixItems" in node);
    assert.deepEqual(offenders, []);
  });

  it("types the scatter point as a two-number array", () => {
    const jsonSchema = z.toJSONSchema(chartPlanSchema) as Record<string, any>;
    const variants = jsonSchema.properties.series.items.properties.data.items.anyOf;
    const arrayVariant = variants.find((v: Record<string, unknown>) => v.type === "array");
    assert.deepEqual(arrayVariant, {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    });
  });
});

describe("chart data point coercion", () => {
  const dataPoint = chartPlanSchema.shape.series.element.shape.data.element;

  it("keeps the shapes a SQL row set produces", () => {
    assert.equal(dataPoint.parse(12.5), 12.5);
    assert.equal(dataPoint.parse("12.5"), 12.5);
    assert.equal(dataPoint.parse(null), null);
    assert.deepEqual(dataPoint.parse([1, 2]), [1, 2]);
    assert.deepEqual(dataPoint.parse({ name: "ATL", value: 3 }), { name: "ATL", value: 3 });
  });

  it("degrades unusable values to null instead of failing the plan", () => {
    assert.equal(dataPoint.parse("not a number"), null);
    assert.equal(dataPoint.parse(Number.POSITIVE_INFINITY), null);
    assert.equal(dataPoint.parse({ nope: true }), null);
  });
});
