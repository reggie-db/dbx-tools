import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveGraphitiConfig } from "../src/config.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveGraphitiConfig", () => {
  it("derives the AppKit port and defers Graphiti port allocation", () => {
    process.env.DATABRICKS_APP_PORT = "9000";
    process.env.DATABRICKS_APP_NAME = "demo";

    assert.deepEqual(resolveGraphitiConfig(), {
      publicPort: 9000,
      appPort: 9001,
      graphitiPort: 0,
      litellmPort: 0,
      routePrefix: "/graphiti",
      python: "python3",
      journalNamespace: "demo",
    });
  });

  it("normalizes a configured route prefix", () => {
    assert.equal(resolveGraphitiConfig({ routePrefix: "memory/" }).routePrefix, "/memory");
  });

  it("rejects colliding ports", () => {
    assert.throws(
      () => resolveGraphitiConfig({ publicPort: 8000, appPort: 8000 }),
      /ports must be distinct/,
    );
  });
});
