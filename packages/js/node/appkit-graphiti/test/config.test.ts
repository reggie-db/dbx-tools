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

  it("preserves AppKit base configuration without parsing it as Graphiti options", () => {
    const resolved = resolveGraphitiConfig({
      name: "memory",
      host: "appkit.internal",
      telemetry: { traces: true },
      streamConfig: { maxEventSize: 1024 },
    });

    assert.equal(resolved.name, "memory");
    assert.equal(resolved.host, "appkit.internal");
    assert.deepEqual(resolved.telemetry, { traces: true });
    assert.deepEqual(resolved.streamConfig, { maxEventSize: 1024 });
    assert.equal(resolved.startupTimeoutMs, 180_000);
  });
});
