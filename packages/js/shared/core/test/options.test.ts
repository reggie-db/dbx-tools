import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DatabricksEnvironmentNamesSchema,
  DatabricksOptionsSchema,
  LakebaseOptionsSchema,
  databricksEnvironmentNames,
  formatListenAddress,
  listenAddressSchema,
  normalizedUrlSchema,
  parseOptionOverrides,
  parseOptions,
  serializeOptions,
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

  it("validates TCP ports with and without the zero sentinel", () => {
    assert.equal(tcpPortSchema.parse("443"), 443);
    assert.equal(tcpPortOrZeroSchema.parse("0"), 0);
    assert.throws(() => tcpPortSchema.parse(0));
    assert.throws(() => tcpPortOrZeroSchema.parse(65_536));
  });

  it("parses and formats listener addresses", () => {
    const schema = listenAddressSchema({ port: 4000, loopback: true });
    assert.deepEqual(schema.parse(4444), { host: "localhost", port: 4444 });
    assert.deepEqual(schema.parse(":4444"), { host: "localhost", port: 4444 });
    assert.deepEqual(schema.parse("LOCALHOST:4444"), { host: "localhost", port: 4444 });
    assert.equal(formatListenAddress({ host: "::1", port: 4444 }), "[::1]:4444");
    assert.throws(() => schema.parse("0.0.0.0:4444"), /loopback/);
  });

  it("normalizes URL and bare-host inputs", () => {
    assert.equal(normalizedUrlSchema.parse("example.com"), "https://example.com");
  });

  it("parses nullable flag maps over environment maps", () => {
    const schema = DatabricksOptionsSchema.pick({ profile: true, host: true });
    assert.deepEqual(
      parseOptions(
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
    assert.deepEqual(
      parseOptionOverrides(schema, null, { DATABRICKS_CONFIG_PROFILE: "env-profile" }),
      { profile: "env-profile" },
    );
    assert.deepEqual(
      parseOptions(LakebaseOptionsSchema, null, {
        LAKEBASE_ENDPOINT: "projects/example",
      }),
      { lakebaseEndpoint: "projects/example" },
    );
  });

  it("serializes complete option JSON by flag or environment name", () => {
    const schema = DatabricksOptionsSchema.pick({ profile: true, host: true });
    const values = { profile: "PROFILE", host: "workspace.example.com" };
    assert.deepEqual(JSON.parse(serializeOptions(schema, values, "flag")), {
      "--profile": "PROFILE",
    });
    assert.deepEqual(JSON.parse(serializeOptions(schema, values, "env")), {
      DATABRICKS_CONFIG_PROFILE: "PROFILE",
      DATABRICKS_HOST: "https://workspace.example.com",
    });
  });
});
