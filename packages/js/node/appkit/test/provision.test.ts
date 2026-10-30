import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "@databricks/appkit";
import { configUtils } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import {
  applyLakebaseProvisionTargets,
  LAKEBASE_PROVISION_TARGETS_CONFIG_KEY,
  lakebaseGrantStatements,
  type LakebaseProvisionClient,
  resolveLakebaseProvisionTargets,
} from "../src/provision.ts";

describe("Lakebase grants", () => {
  it("quotes the schema and an email-shaped role", () => {
    const statements = lakebaseGrantStatements("appkit", "me@acme.com");
    assert.equal(statements.length, 5);
    for (const sql of statements) {
      assert.match(sql, /"appkit"/);
      assert.match(sql, /"me@acme\.com"/);
    }
    assert.equal(statements[0], 'GRANT USAGE, CREATE ON SCHEMA "appkit" TO "me@acme.com"');
  });

  it("rejects a role name that could not be an identifier", () => {
    for (const bad of ['ev"il', "role; DROP SCHEMA appkit", "", "a b"]) {
      assert.throws(
        () => lakebaseGrantStatements("appkit", bad),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /role/);
          return true;
        },
      );
    }
  });

  it("keeps the grants idempotent and scoped to the cache schema", () => {
    const statements = lakebaseGrantStatements("appkit", "sp-1234").join("\n");
    assert.match(statements, /ALTER DEFAULT PRIVILEGES IN SCHEMA "appkit"/);
    assert.doesNotMatch(statements, /public/);
  });

  it("keeps table grants narrow enough to run without schema ownership", () => {
    assert.deepEqual(lakebaseGrantStatements("reporting.events", "sp-1234"), [
      'GRANT ALL PRIVILEGES ON TABLE "reporting"."events" TO "sp-1234"',
    ]);
  });

  it("rejects targets other than schema or schema.table", () => {
    for (const bad of ["", "reporting.events.daily", "reporting.*", "bad-schema"]) {
      assert.throws(() => lakebaseGrantStatements(bad, "sp-1234"));
    }
  });

  it("adds configured and CSV environment targets and removes exact duplicates", () => {
    const name = configUtils.name(LAKEBASE_PROVISION_TARGETS_CONFIG_KEY);
    const previous = process.env[name];
    try {
      process.env[name] = "reporting.events, reporting, metrics.daily,metrics.daily";
      assert.deepEqual(
        resolveLakebaseProvisionTargets(["appkit", "operations.jobs", "reporting.events"]),
        [
          "appkit",
          "mastra_instance",
          "operations.jobs",
          "reporting.events",
          "reporting",
          "metrics.daily",
        ],
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("skips table fallbacks after a successful schema grant", async () => {
    const queries: string[] = [];
    const client = clientWith(async (sql) => {
      queries.push(sql);
      return { rowCount: sql.startsWith("SELECT") ? 1 : 0 };
    });

    await applyLakebaseProvisionTargets(
      client,
      "sp-1234",
      ["reporting.events", "reporting", "reporting.events"],
      log.logger("test:provision"),
    );

    assert.equal(queries.filter((sql) => sql.includes("pg_catalog.pg_class")).length, 0);
    assert.equal(queries.filter((sql) => sql.includes('ON TABLE "reporting"."events"')).length, 0);
  });

  it("falls back to table grants when the schema transaction fails", async () => {
    const queries: string[] = [];
    const client = clientWith(async (sql) => {
      queries.push(sql);
      if (sql.includes("ALL TABLES IN SCHEMA")) throw new Error("not schema owner");
      return { rowCount: sql.startsWith("SELECT") ? 1 : 0 };
    });

    await applyLakebaseProvisionTargets(
      client,
      "sp-1234",
      ["reporting", "reporting.events"],
      log.logger("test:provision"),
    );

    assert.ok(queries.includes("ROLLBACK"));
    assert.ok(queries.some((sql) => sql.includes("pg_catalog.pg_class")));
    assert.ok(queries.includes('GRANT ALL PRIVILEGES ON TABLE "reporting"."events" TO "sp-1234"'));
  });

  it("debug-skips absent tables without issuing a grant", async () => {
    const queries: string[] = [];
    const client = clientWith(async (sql) => {
      queries.push(sql);
      return { rowCount: 0 };
    });

    await applyLakebaseProvisionTargets(
      client,
      "sp-1234",
      ["reporting.events"],
      log.logger("test:provision"),
    );

    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /pg_catalog\.pg_class/);
  });
});

function clientWith(query: LakebaseProvisionClient["query"]): LakebaseProvisionClient {
  return { query };
}
