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
    assert.deepEqual(
      config.machineSoftware.map((software) => software.name),
      ["mise"],
    );
    assert.match(config.machineSoftware[0]?.installCommand ?? "", /dbx-tools mise path/);
    assert.doesNotMatch(config.machineSoftware[0]?.installCommand ?? "", /mise activate (?:bash|zsh)/);
    assert.match(config.machineSoftware[0]?.checkCommand ?? "", /\.zshrc/);
    assert.equal("context" in config, false);

    const fallback = resolveSshPluginConfig({ fallbackToServicePrincipal: true });
    assert.equal(fallback.fallbackToServicePrincipal, true);

    const withoutSetup = resolveSshPluginConfig({ machineSoftware: [] });
    assert.deepEqual(withoutSetup.machineSoftware, []);
  });
});
