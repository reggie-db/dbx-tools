import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { createTestApp } from "@databricks/appkit/testing";

interface ShutdownProbeConfig extends BasePluginConfig {
  calls?: string[];
}

class ShutdownProbePlugin extends Plugin<ShutdownProbeConfig> {
  static manifest = {
    name: "shutdownProbe",
    displayName: "Shutdown Probe",
    description: "Native lifecycle test fixture",
    stability: "stable",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"shutdownProbe">;

  override async setup() {
    this.config.calls?.push("setup");
  }

  override async shutdown() {
    this.config.calls?.push("shutdown");
  }
}

const shutdownProbe = toPlugin(ShutdownProbePlugin);

describe("AppKit native lifecycle compatibility", () => {
  it("joins idempotent close and permits sequential no-server boots", async () => {
    const firstCalls: string[] = [];
    const first = await createTestApp({
      plugins: [shutdownProbe({ calls: firstCalls })],
      server: false,
    });

    await Promise.all([first.close(), first.close()]);
    assert.deepEqual(firstCalls, ["setup", "shutdown"]);

    const secondCalls: string[] = [];
    const second = await createTestApp({
      plugins: [shutdownProbe({ calls: secondCalls })],
      server: false,
    });
    await second.close();
    assert.deepEqual(secondCalls, ["setup", "shutdown"]);
  });
});
