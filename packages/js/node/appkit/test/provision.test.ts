import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "@databricks/appkit";
import { cacheGrantStatements } from "../src/provision.ts";

describe("cache schema grants", () => {
  it("quotes the schema and an email-shaped role", () => {
    const statements = cacheGrantStatements("me@acme.com");
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
        () => cacheGrantStatements(bad),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /role/);
          return true;
        },
      );
    }
  });

  it("keeps the grants idempotent and scoped to the cache schema", () => {
    const statements = cacheGrantStatements("sp-1234").join("\n");
    assert.match(statements, /ALTER DEFAULT PRIVILEGES IN SCHEMA "appkit"/);
    assert.doesNotMatch(statements, /public/);
  });
});
