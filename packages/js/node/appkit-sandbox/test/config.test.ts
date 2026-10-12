import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSshPluginConfig } from "../src/config.ts";

describe("resolveSshPluginConfig", () => {
  it("strips AppKit runtime fields and resolves auth fallback defaults", () => {
    const config = resolveSshPluginConfig({ context: {} as never });
    assert.equal(config.fallbackToServicePrincipal, false);
    assert.equal(config.sandboxLifetimeSeconds, 86_400);
    assert.equal(config.reaperIntervalSeconds, 300);
    assert.equal(config.routePrefix, "/sandbox");
    assert.equal("context" in config, false);

    const fallback = resolveSshPluginConfig({ fallbackToServicePrincipal: true });
    assert.equal(fallback.fallbackToServicePrincipal, true);
  });
});
