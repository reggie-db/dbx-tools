import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveLakeboxPluginConfig } from "../src/config.ts";

describe("Lakebox startup recovery configuration", () => {
  it("keeps destructive recovery disabled by default", () => {
    assert.equal(
      resolveLakeboxPluginConfig({ application: "recovery-test" })
        .destroyAfterStartupFailureSeconds,
      false,
    );
  });

  it("accepts an explicit destructive recovery timeout", () => {
    assert.equal(
      resolveLakeboxPluginConfig({
        application: "recovery-test",
        destroyAfterStartupFailureSeconds: 30,
      }).destroyAfterStartupFailureSeconds,
      30,
    );
  });

  it("rejects destructive recovery outside its bounded range", () => {
    assert.throws(() =>
      resolveLakeboxPluginConfig({
        application: "recovery-test",
        destroyAfterStartupFailureSeconds: 4,
      }),
    );
    assert.throws(() =>
      resolveLakeboxPluginConfig({
        application: "recovery-test",
        destroyAfterStartupFailureSeconds: 601,
      }),
    );
  });
});
