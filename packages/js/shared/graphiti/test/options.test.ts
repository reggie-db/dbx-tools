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

    assert.equal(options.model, "databricks-gpt-5-nano");
    assert.equal(options.temperature, 1);
    assert.equal(options.embedderModel, "gte-large-en");
    assert.equal(options.embedderDimensions, 1024);
    assert.deepEqual(options.listen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 7272,
    });
  });

  it("normalizes model values without duplicating environment policy", () => {
    const options = resolveGraphitiOptions({
      model: "  gpt  ",
    });

    assert.equal(options.model, "gpt");
  });

  it("parses environment names without reading process state", () => {
    assert.deepEqual(
      graphitiOptionsFromEnvironment({
        DATABRICKS_CONFIG_PROFILE: "PROFILE",
        TEMPERATURE: "0.25",
        GRAPHITI_HOME: "/graphiti",
        GRAPHITI_LISTEN: "tcp://localhost:8100",
      }),
      {
        profile: "PROFILE",
        temperature: 0.25,
        graphitiHome: "/graphiti",
        listen: { scheme: "tcp", host: "localhost", port: 8100 },
      },
    );
  });

  it("serializes the resolved configuration as one process environment", () => {
    const environment = graphitiOptionsEnvironment({
      profile: "PROFILE",
      listen: "tcp://localhost:8100",
    });

    assert.equal(environment.DATABRICKS_CONFIG_PROFILE, "PROFILE");
    assert.equal(environment.MODEL_NAME, "databricks-gpt-5-nano");
    assert.equal(environment.EMBEDDER_MODEL, "gte-large-en");
    assert.equal(environment.GRAPHITI_LISTEN, "tcp://localhost:8100");
    assert.equal(environment.DATABASE_URL, undefined);
    assert.ok(Object.values(environment).every((value) => typeof value === "string"));
  });
});
