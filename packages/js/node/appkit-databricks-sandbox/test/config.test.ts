import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSshPluginConfig } from "../src/config.ts";

describe("resolveSshPluginConfig", () => {
  it("strips AppKit runtime fields and resolves auth fallback defaults", () => {
    const config = resolveSshPluginConfig({ context: {} as never });
    assert.equal(config.fallbackToServicePrincipal, false);
    assert.equal(config.ownershipStorage, "auto");
    assert.match(config.ownershipPath, /dbx-tools.*sandbox.*machine-assignments\.json/);
    assert.deepEqual(config.machineAssignments, []);
    assert.equal(config.routePrefix, "/sandbox");
    assert.equal("context" in config, false);

    const fallback = resolveSshPluginConfig({ fallbackToServicePrincipal: true });
    assert.equal(fallback.fallbackToServicePrincipal, true);
  });
});
