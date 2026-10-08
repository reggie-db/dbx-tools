import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  DatabricksEnvironmentNamesSchema,
  DatabricksOptionsSchema,
  LakebaseOptionsSchema,
  PostgresEnvironmentNamesSchema,
  PostgresOptionsSchema,
  databricksEnvironmentNames,
  formatListenAddress,
  listenAddressSchema,
  normalizedUrlSchema,
  parseOpts,
  postgresEnvironmentNames,
  serializeOptsEnvironment,
  tcpPortOrZeroSchema,
  tcpPortSchema,
} from "../src/options.ts";

describe("shared option schemas", () => {
  it("supports Databricks environment subsets", () => {
    const authEnvironment = DatabricksEnvironmentNamesSchema.pick({
      profile: true,
      host: true,
    }).parse({});
    assert.deepEqual(authEnvironment, {
      profile: "DATABRICKS_CONFIG_PROFILE",
      host: "DATABRICKS_HOST",
    });
    assert.equal(databricksEnvironmentNames.lakebaseEndpoint, "LAKEBASE_ENDPOINT");
  });

  it("owns the shared PostgreSQL role option and environment", () => {
    assert.deepEqual(PostgresEnvironmentNamesSchema.parse({}), {
      postgresRole: "DBX_TOOLS_POSTGRES_ROLE",
    });
    assert.equal(postgresEnvironmentNames.postgresRole, "DBX_TOOLS_POSTGRES_ROLE");
    assert.deepEqual(
      parseOpts(PostgresOptionsSchema, null, {
        DBX_TOOLS_POSTGRES_ROLE: "  app-owner@example.com  ",
      }),
      { postgresRole: "app-owner@example.com" },
    );
    assert.throws(() => PostgresOptionsSchema.parse({ postgresRole: "invalid role" }));
  });

  it("validates TCP ports with and without the zero sentinel", () => {
    assert.equal(tcpPortSchema.parse("443"), 443);
    assert.equal(tcpPortOrZeroSchema.parse("0"), 0);
    assert.throws(() => tcpPortSchema.parse(0));
    assert.throws(() => tcpPortOrZeroSchema.parse(65_536));
  });

  it("parses and formats listener addresses", () => {
    const schema = listenAddressSchema({ port: 4000, loopback: true });
    assert.deepEqual(schema.parse(4444), { scheme: "tcp", host: "localhost", port: 4444 });
    assert.deepEqual(schema.parse(":4444"), {
      scheme: "tcp",
      host: "localhost",
      port: 4444,
    });
    assert.deepEqual(schema.parse("tcp://LOCALHOST:4444"), {
      scheme: "tcp",
      host: "localhost",
      port: 4444,
    });
    assert.equal(
      formatListenAddress({ scheme: "tcp", host: "::1", port: 4444 }),
      "tcp://[::1]:4444",
    );
    assert.throws(() => schema.parse("0.0.0.0:4444"), /loopback/);
  });

  it("parses Unix listeners and allows overriding the default scheme", () => {
    const schema = listenAddressSchema({
      port: 6379,
      scheme: "unix",
      schemes: ["tcp", "unix"],
      withDefault: false,
    });
    assert.deepEqual(schema.parse("/tmp/database.sock"), {
      scheme: "unix",
      path: "/tmp/database.sock",
    });
    assert.deepEqual(schema.parse("unix:///tmp/database.sock"), {
      scheme: "unix",
      path: "/tmp/database.sock",
    });
    assert.deepEqual(schema.parse("tcp://127.0.0.1:6379"), {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 6379,
    });
  });

  it("normalizes URL and bare-host inputs", () => {
    assert.equal(normalizedUrlSchema.parse("example.com"), "https://example.com");
  });

  it("parses nullable flag maps over environment maps", () => {
    const schema = DatabricksOptionsSchema.pick({ profile: true, host: true });
    assert.deepEqual(
      parseOpts(
        schema,
        { "--profile": "cli-profile", host: null },
        {
          DATABRICKS_CONFIG_PROFILE: "env-profile",
          DATABRICKS_HOST: "workspace.example.com",
        },
      ),
      {
        profile: "cli-profile",
        host: "https://workspace.example.com",
      },
    );
    assert.deepEqual(parseOpts(schema, null, { DATABRICKS_CONFIG_PROFILE: "env-profile" }), {
      profile: "env-profile",
    });
    assert.deepEqual(
      parseOpts(LakebaseOptionsSchema, null, {
        LAKEBASE_ENDPOINT: "projects/example",
      }),
      { lakebaseEndpoint: "projects/example" },
    );
  });

  it("serializes typed options into process environment strings", () => {
    const schema = z.object({
      port: z.number().meta({ env: "PORT" }),
      enabled: z.boolean().meta({ env: "ENABLED" }),
      values: z.array(z.string()).meta({ env: "VALUES" }),
    });

    assert.deepEqual(
      serializeOptsEnvironment(schema, {
        port: 8000,
        enabled: true,
        values: ["one", "two"],
      }),
      {
        PORT: "8000",
        ENABLED: "true",
        VALUES: "one,two",
      },
    );
  });
});
