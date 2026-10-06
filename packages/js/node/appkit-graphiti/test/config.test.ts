import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GRAPHITI_DEFAULTS } from "@dbx-tools/graphiti/options";
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
      listen: { scheme: "tcp", host: "127.0.0.1", port: 0 },
    });
  });
});
