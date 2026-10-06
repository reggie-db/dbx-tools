import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GRAPHITI_DEFAULTS } from "@dbx-tools/shared-graphiti";
import { resolveGraphitiConfig } from "../src/config.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveGraphitiConfig", () => {
  it("defers sidecar port allocation", () => {
    delete process.env.DATABRICKS_CONFIG_PROFILE;

    assert.deepEqual(resolveGraphitiConfig(), {
      ...GRAPHITI_DEFAULTS,
      graphitiPort: 0,
      modelGatewayPort: 0,
    });
  });

  it("rejects colliding ports", () => {
    assert.throws(
      () => resolveGraphitiConfig({ graphitiPort: 8000, modelGatewayPort: 8000 }),
      /ports must be distinct/,
    );
  });
});
