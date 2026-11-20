import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statementCellText, statementColumnLabel } from "../src/support/statement-presentation.ts";

describe("statement result presentation", () => {
  it("humanizes aliases without flattening analytics acronyms", () => {
    assert.equal(statementColumnLabel("business_week"), "Business Week");
    assert.equal(statementColumnLabel("total_guest_count_pspw"), "Total Guest Count PSPW");
    assert.equal(statementColumnLabel("yoy_pct_pspw"), "YoY % PSPW");
  });

  it("formats common Metric View result semantics", () => {
    assert.equal(
      statementCellText({ name: "inside_guest_count", typeName: "LONG" }, 4_868_922),
      "4,868,922",
    );
    assert.equal(
      statementCellText({ name: "fuel_gallons_sold_pspw", typeName: "DOUBLE" }, 125_089.92),
      "125,090",
    );
    assert.equal(
      statementCellText({ name: "ly_pspw", typeName: "DOUBLE" }, 8_115.15558312655),
      "8,115",
    );
    assert.equal(
      statementCellText({ name: "fuel_margin_pspw", typeName: "DOUBLE" }, 50_280.31),
      "$50,280.31",
    );
    assert.equal(
      statementCellText({ name: "yoy_pct_pspw", typeName: "DOUBLE" }, -0.038653328483108824),
      "-3.87%",
    );
  });

  it("leaves dates, identifiers, and nulls stable", () => {
    assert.equal(
      statementCellText({ name: "business_week", typeName: "DATE" }, "2026-11-17"),
      "2026-11-17",
    );
    assert.equal(statementCellText({ name: "store_number", typeName: "INT" }, "0012"), "0012");
    assert.equal(statementCellText({ name: "value", typeName: "DOUBLE" }, null), "");
  });
});
