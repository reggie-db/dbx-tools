import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { location, plan } from "./fixtures.ts";
import { compileGeneratorTableSql, compileMetricValidationSql } from "../src/data.ts";
import { generatorSchemaName } from "../src/namespace.ts";

describe("generator SQL and namespace compilation", () => {
  it("derives readable per-user schema names", () => {
    assert.equal(
      generatorSchemaName("reggie.pierce@databricks.com", "Acme Foods", "Support Operations"),
      "reggie_pierce_acme_foods_support_operations",
    );
  });

  it("compiles only typed generators into bounded Delta SQL", () => {
    const sql = compileGeneratorTableSql(location, plan);
    assert.match(sql, /CREATE OR REPLACE TABLE `reggie_pierce_aws_catalog`/);
    assert.match(sql, /FROM range\(50000\)/);
    assert.match(sql, /date_sub\(current_date\(\)/);
    assert.match(sql, /case when pmod/);
    assert.match(sql, /1\.65/);
  });

  it("compiles KPI validation from the typed aggregate", () => {
    assert.equal(
      compileMetricValidationSql(location.fullName + "." + plan.table, plan.metrics[0]!),
      "SELECT avg(`resolution_hours`) AS `avg_resolution_hours` FROM reggie_pierce_aws_catalog.reggie_acme_support_operations.support_events",
    );
  });
});
