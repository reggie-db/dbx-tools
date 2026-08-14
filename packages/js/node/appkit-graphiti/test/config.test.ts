import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveGraphitiConfig } from "../src/config.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveGraphitiConfig", () => {
  it("defers sidecar port allocation", () => {
    process.env.DATABRICKS_APP_NAME = "demo";

    assert.deepEqual(resolveGraphitiConfig(), {
      graphitiPort: 0,
      litellmPort: 0,
      proxyPort: 0,
      python: "python3",
      journalNamespace: "demo",
    });
  });

  it("rejects colliding ports", () => {
    assert.throws(
      () => resolveGraphitiConfig({ graphitiPort: 8000, proxyPort: 8000 }),
      /ports must be distinct/,
    );
  });
});
