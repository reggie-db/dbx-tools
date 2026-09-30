import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAutoConfigurePolicy } from "../src/_auto-configure.ts";

describe("automatic database configuration policy", () => {
  it("skips an unconfigured app with no native database demand", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["server"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: false,
      databasePluginPresent: false,
      shouldResolve: false,
      provision: false,
      skippedReason: "no database plugin",
    });
  });

  it("preserves implicit Lakebase provisioning", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["lakebase"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: true,
      databasePluginPresent: false,
      shouldResolve: true,
      provision: true,
    });
  });

  it("resolves database-only environment without broadening cache grants", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["database"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: false,
      databasePluginPresent: true,
      shouldResolve: true,
      provision: false,
    });
  });

  it("provisions once when lakebase and database are both present", () => {
    assert.equal(resolveAutoConfigurePolicy(["database", "lakebase"], undefined).provision, true);
  });

  it("honors every explicit mode independently of plugin demand", () => {
    assert.deepEqual(resolveAutoConfigurePolicy([], "env"), {
      mode: "env",
      explicit: true,
      lakebasePluginPresent: false,
      databasePluginPresent: false,
      shouldResolve: true,
      provision: false,
    });
    assert.equal(resolveAutoConfigurePolicy(["database"], "provision").provision, true);
    assert.deepEqual(resolveAutoConfigurePolicy(["lakebase", "database"], false), {
      mode: false,
      explicit: true,
      lakebasePluginPresent: true,
      databasePluginPresent: true,
      shouldResolve: false,
      provision: false,
      skippedReason: "disabled",
    });
  });
});
