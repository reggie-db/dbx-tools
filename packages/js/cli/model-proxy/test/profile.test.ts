import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDatabricksProfile, selectDatabricksProfile } from "../src/_profile.ts";

describe("selectDatabricksProfile", () => {
  it("prefers the profile marked as the CLI default", () => {
    assert.equal(
      selectDatabricksProfile({
        profiles: [{ name: "DEFAULT" }, { name: "chosen", default: true }],
      }),
      "chosen",
    );
  });

  it("falls back to the profile named DEFAULT", () => {
    assert.equal(
      selectDatabricksProfile({
        profiles: [{ name: "other" }, { name: "DEFAULT" }],
      }),
      "DEFAULT",
    );
  });

  it("falls back to the only configured profile", () => {
    assert.equal(selectDatabricksProfile({ profiles: [{ name: "only" }] }), "only");
  });

  it("leaves multiple unmarked profiles unresolved", () => {
    assert.equal(
      selectDatabricksProfile({ profiles: [{ name: "one" }, { name: "two" }] }),
      undefined,
    );
  });
});

describe("resolveDatabricksProfile", () => {
  it("prefers an explicit profile over the environment", () => {
    assert.equal(
      resolveDatabricksProfile(" explicit ", {
        environ: { DATABRICKS_CONFIG_PROFILE: "environment" },
      }),
      "explicit",
    );
  });

  it("uses DATABRICKS_CONFIG_PROFILE when no profile is explicit", () => {
    assert.equal(
      resolveDatabricksProfile(undefined, {
        environ: { DATABRICKS_CONFIG_PROFILE: " environment " },
      }),
      "environment",
    );
  });

  it("preserves ambient authentication when a host is configured", () => {
    assert.equal(
      resolveDatabricksProfile(undefined, {
        environ: { DATABRICKS_HOST: "https://workspace.example.com" },
      }),
      undefined,
    );
  });
});
