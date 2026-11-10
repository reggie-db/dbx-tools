import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KpiResearchRequestSchema } from "../src/kpi.ts";
import { GeneratorRequestSchema } from "../src/workflow.ts";

const REQUEST = {
  company: " Example ",
  purpose: " Sales ",
  queries: [" What drives revenue? "],
};

describe("generator research request composition", () => {
  it("reuses research fields and adds workflow defaults", () => {
    for (const field of ["company", "purpose", "queries"] as const) {
      assert.equal(GeneratorRequestSchema.shape[field], KpiResearchRequestSchema.shape[field]);
    }
    assert.deepEqual(GeneratorRequestSchema.parse(REQUEST), {
      ...KpiResearchRequestSchema.parse(REQUEST),
      presentation: "dashboard",
      rowCount: 50_000,
    });
  });

  it("preserves research constraints and strict workflow fields", () => {
    for (const input of [
      { ...REQUEST, company: " " },
      { ...REQUEST, company: "a".repeat(201) },
      { ...REQUEST, purpose: "a".repeat(201) },
      { ...REQUEST, queries: [] },
      { ...REQUEST, queries: [" "] },
      { ...REQUEST, queries: ["a".repeat(501)] },
      { ...REQUEST, queries: Array.from({ length: 11 }, () => "Question?") },
    ]) {
      assert.throws(() => KpiResearchRequestSchema.parse(input));
      assert.throws(() => GeneratorRequestSchema.parse(input));
    }
    for (const input of [
      { ...REQUEST, rowCount: 999 },
      { ...REQUEST, rowCount: 100_001 },
      { ...REQUEST, presentation: "unknown" },
      { ...REQUEST, website: "not-a-url" },
      { ...REQUEST, unknown: true },
    ]) {
      assert.throws(() => GeneratorRequestSchema.parse(input));
    }
  });
});
