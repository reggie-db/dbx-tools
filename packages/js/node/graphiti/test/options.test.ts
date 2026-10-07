import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphitiOptionsEnvironment, resolveGraphitiOptions } from "../src/options.ts";

describe("Graphiti runtime options", () => {
  it("uses embedded PostgreSQL when no database is configured", () => {
    const resolved = resolveGraphitiOptions();

    assert.deepEqual(resolved.listen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 7272,
    });
    assert.equal(resolved.databaseUrl, undefined);
  });

  it("serializes database-agnostic environment names", () => {
    const values = {
      databaseUrl: "postgresql://localhost:5433/graphiti",
    };

    const environment = graphitiOptionsEnvironment(values);
    assert.equal(environment.LAKEBASE_ENDPOINT, "postgresql://localhost:5433/graphiti");
  });
});
