import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import { createTestPlugin, createTestPluginContext } from "@databricks/appkit/testing";
import { data, instance, require as requirePlugin } from "../src/plugin-registry.ts";

class FakeLakebasePlugin extends Plugin {
  static manifest = {
    name: "lakebase",
    displayName: "Fake Lakebase",
    description: "Test fixture",
    stability: "stable",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"lakebase">;

  override exports() {
    return { pool: "pool" };
  }
}

const fakeLakebase = toPlugin(FakeLakebasePlugin);

function fakeFactory(name: string, calls: { count: number }) {
  return () => {
    calls.count += 1;
    return { plugin: FakeLakebasePlugin, name };
  };
}

describe("plugin lookup", () => {
  it("caches the factory descriptor per factory", () => {
    const calls = { count: 0 };
    const factory = fakeFactory("lakebase", calls);
    assert.equal(data(factory).name, "lakebase");
    assert.equal(data(factory).name, "lakebase");
    assert.equal(calls.count, 1);
  });

  it("returns the registered instance, or undefined without a context", async () => {
    const fixture = createTestPluginContext();
    const registered = await fixture.attach(createTestPlugin(fakeLakebase));
    assert.equal(instance(fixture.ctx, fakeLakebase), registered);
    assert.equal(instance(createTestPluginContext().ctx, fakeLakebase), undefined);
    assert.equal(instance(undefined, fakeLakebase), undefined);
  });

  it("require returns the instance when registered", async () => {
    const fixture = createTestPluginContext();
    const registered = await fixture.attach(createTestPlugin(fakeLakebase));
    assert.equal(requirePlugin(fixture.ctx, fakeLakebase), registered);
  });

  it("require throws a ConfigurationError naming the plugin and the caller", () => {
    const fixture = createTestPluginContext();
    assert.throws(
      () => requirePlugin(fixture.ctx, fakeLakebase, "mastra"),
      (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /mastra/);
        assert.match(err.message, /lakebase/);
        return true;
      },
    );
  });

  it("require throws without a context at all", () => {
    assert.throws(() => requirePlugin(undefined, fakeLakebase), ConfigurationError);
  });
});
