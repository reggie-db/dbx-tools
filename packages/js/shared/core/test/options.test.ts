import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  DatabricksEnvironmentNamesSchema,
  DatabricksOptionsSchema,
  LakebaseOptionsSchema,
  databricksEnvironmentNames,
  formatListenAddress,
  listenAddressSchema,
  normalizedUrlSchema,
  parseOpts,
  serializeOpts,
  serializeOptsEnvironment,
  namespaceOpts,
  unnamespaceOpts,
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
    assert.deepEqual(schema.parse("/tmp/falkordb.sock"), {
      scheme: "unix",
      path: "/tmp/falkordb.sock",
    });
    assert.deepEqual(schema.parse("unix:///tmp/falkordb.sock"), {
      scheme: "unix",
      path: "/tmp/falkordb.sock",
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

  it("serializes complete option JSON by flag or environment name", () => {
    const schema = DatabricksOptionsSchema.pick({ profile: true, host: true });
    const values = { profile: "PROFILE", host: "workspace.example.com" };
    assert.deepEqual(JSON.parse(serializeOpts(schema, values, "flag")), {
      "--profile": "PROFILE",
    });
    assert.deepEqual(JSON.parse(serializeOpts(schema, values, "env")), {
      DATABRICKS_CONFIG_PROFILE: "PROFILE",
      DATABRICKS_HOST: "https://workspace.example.com",
    });
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

  it("namespaces reusable option fields without replacing their schemas", () => {
    const schema = namespaceOpts(
      z.object({
        dataDir: z.string().meta({ env: "FALKORDB_DATA_DIR" }),
      }),
      "falkor",
    );

    assert.deepEqual(schema.parse({ falkorDataDir: "/data" }), {
      falkorDataDir: "/data",
    });
    assert.deepEqual(JSON.parse(serializeOpts(schema, { falkorDataDir: "/data" }, "flag")), {
      "--falkor-data-dir": "/data",
    });
    assert.deepEqual(serializeOptsEnvironment(schema, { falkorDataDir: "/data" }), {
      FALKORDB_DATA_DIR: "/data",
    });
    assert.deepEqual(
      unnamespaceOpts(z.object({ dataDir: z.string() }), { falkorDataDir: "/data" }, "falkor"),
      { dataDir: "/data" },
    );
  });
});
