import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  graphitiOptionsEnvironment,
  graphitiOptionsFromEnvironment,
  resolveGraphitiOptions,
} from "../src/options.ts";

describe("Graphiti options", () => {
  it("applies the shared model defaults", () => {
    const options = resolveGraphitiOptions();

    assert.equal(options.modelClass, "chat-fast");
    assert.equal(options.temperature, 1);
    assert.equal(options.startupTimeoutMs, 180_000);
    assert.equal(options.databaseSchema, "dbx_tools_graphiti");
    assert.deepEqual(options.listen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 7272,
    });
  });

  it("uses the shared chat-class contract", () => {
    assert.equal(
      resolveGraphitiOptions({ modelClass: "chat-thinking" }).modelClass,
      "chat-thinking",
    );
    assert.throws(() => resolveGraphitiOptions({ modelClass: "embedding" as never }));
  });

  it("parses environment names without reading process state", () => {
    assert.deepEqual(
      graphitiOptionsFromEnvironment({
        DATABRICKS_CONFIG_PROFILE: "PROFILE",
        TEMPERATURE: "0.25",
        DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS: "240000",
        DBX_TOOLS_POSTGRES_ROLE: "graphiti_owner",
        GRAPHITI_DATABASE_SCHEMA: "graphiti_memory",
        GRAPHITI_HOME: "/graphiti",
        GRAPHITI_LISTEN: "tcp://localhost:8100",
        MODEL_CLASS: "chat-balanced",
      }),
      {
        profile: "PROFILE",
        temperature: 0.25,
        startupTimeoutMs: 240_000,
        postgresRole: "graphiti_owner",
        databaseSchema: "graphiti_memory",
        graphitiHome: "/graphiti",
        listen: { scheme: "tcp", host: "localhost", port: 8100 },
        modelClass: "chat-balanced",
      },
    );
  });

  it("prefers the Lakebase endpoint over the generic database URL", () => {
    assert.equal(
      graphitiOptionsFromEnvironment({
        LAKEBASE_ENDPOINT: "projects/example/branches/production/endpoints/primary",
        DATABASE_URL: "postgresql://fallback.example/graphiti",
      }).databaseUrl,
      "projects/example/branches/production/endpoints/primary",
    );
    assert.equal(
      graphitiOptionsFromEnvironment({
        DATABASE_URL: "postgresql://fallback.example/graphiti",
      }).databaseUrl,
      "postgresql://fallback.example/graphiti",
    );
  });

  it("serializes the resolved configuration as one process environment", () => {
    const environment = graphitiOptionsEnvironment({
      profile: "PROFILE",
      listen: "tcp://localhost:8100",
    });

    assert.equal(environment.DATABRICKS_CONFIG_PROFILE, "PROFILE");
    assert.equal(environment.MODEL_CLASS, "chat-fast");
    assert.equal(environment.DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS, "180000");
    assert.equal(environment.DBX_TOOLS_POSTGRES_ROLE, undefined);
    assert.equal(environment.GRAPHITI_DATABASE_SCHEMA, "dbx_tools_graphiti");
    assert.equal(environment.GRAPHITI_LISTEN, "tcp://localhost:8100");
    assert.equal(environment.DATABASE_URL, undefined);
    assert.ok(Object.values(environment).every((value) => typeof value === "string"));
  });

  it("rejects non-positive startup budgets", () => {
    assert.throws(() => resolveGraphitiOptions({ startupTimeoutMs: 0 }));
    assert.throws(() => resolveGraphitiOptions({ startupTimeoutMs: -1 }));
  });

  it("rejects database schema values that require SQL quoting", () => {
    assert.throws(() => resolveGraphitiOptions({ databaseSchema: "graphiti-memory" }));
  });

  it("uses the shared PostgreSQL role contract", () => {
    assert.equal(
      resolveGraphitiOptions({ postgresRole: "  graphiti-owner@example.com  " }).postgresRole,
      "graphiti-owner@example.com",
    );
    assert.throws(() => resolveGraphitiOptions({ postgresRole: "invalid role" }));
  });
});
