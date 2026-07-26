import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "@databricks/appkit";
import { data, instance, require as requirePlugin, type PluginContextLike } from "../src/plugin";

class FakeLakebasePlugin {
  exports() {
    return { pool: "pool" };
  }
}

function fakeFactory(name: string, calls: { count: number }) {
  return () => {
    calls.count += 1;
    return { plugin: FakeLakebasePlugin, name };
  };
}

function fakeContext(entries: Record<string, unknown>): PluginContextLike {
  const plugins = new Map(Object.entries(entries));
  return { getPlugins: () => plugins };
}

describe("plugin lookup", () => {
  it("caches the factory descriptor per factory", () => {
    const calls = { count: 0 };
    const factory = fakeFactory("lakebase", calls);
    assert.equal(data(factory).name, "lakebase");
    assert.equal(data(factory).name, "lakebase");
    assert.equal(calls.count, 1);
  });

  it("returns the registered instance, or undefined without a context", () => {
    const factory = fakeFactory("lakebase", { count: 0 });
    const plugin = new FakeLakebasePlugin();
    assert.equal(instance(fakeContext({ lakebase: plugin }), factory), plugin);
    assert.equal(instance(fakeContext({}), factory), undefined);
    assert.equal(instance(undefined, factory), undefined);
  });

  it("require returns the instance when registered", () => {
    const factory = fakeFactory("lakebase", { count: 0 });
    const plugin = new FakeLakebasePlugin();
    assert.equal(requirePlugin(fakeContext({ lakebase: plugin }), factory), plugin);
  });

  it("require throws a ConfigurationError naming the plugin and the caller", () => {
    const factory = fakeFactory("lakebase", { count: 0 });
    assert.throws(
      () => requirePlugin(fakeContext({ server: {} }), factory, "mastra"),
      (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /mastra/);
        assert.match(err.message, /lakebase/);
        return true;
      },
    );
  });

  it("require throws without a context at all", () => {
    const factory = fakeFactory("lakebase", { count: 0 });
    assert.throws(() => requirePlugin(undefined, factory), ConfigurationError);
  });
});
