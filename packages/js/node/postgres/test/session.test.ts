import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  postgresConnectionOptions,
  postgresRoleStatement,
  postgresServerSettings,
  quotePostgresIdentifier,
  resolvePostgresRole,
} from "../src/session.ts";

describe("PostgreSQL session roles", () => {
  it("resolves email-shaped managed roles from the shared environment", () => {
    assert.equal(
      resolvePostgresRole(undefined, {
        DBX_TOOLS_POSTGRES_ROLE: "  graphiti-owner@example.com  ",
      }),
      "graphiti-owner@example.com",
    );
  });

  it("rejects values that cannot be passed as startup role options", () => {
    assert.throws(() => resolvePostgresRole('owner"name', {}));
    assert.throws(() => resolvePostgresRole("owner name", {}));
  });

  it("builds SQL, asyncpg, and pg role settings from one policy", () => {
    assert.equal(postgresRoleStatement("graphiti_owner"), 'SET ROLE "graphiti_owner"');
    assert.deepEqual(postgresServerSettings("graphiti_owner", { search_path: "graphiti" }), {
      search_path: "graphiti",
      role: "graphiti_owner",
    });
    assert.deepEqual(
      postgresConnectionOptions({ options: "-c statement_timeout=5000" }, "graphiti_owner"),
      { options: "-c statement_timeout=5000 -c role=graphiti_owner" },
    );
  });

  it("quotes identifiers independently from role validation", () => {
    assert.equal(quotePostgresIdentifier('schema"name'), '"schema""name"');
    assert.throws(() => quotePostgresIdentifier("schema\0name"));
  });
});
