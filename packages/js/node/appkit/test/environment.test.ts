import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDatabricksAppEnv } from "../src/appkit.ts";

describe("isDatabricksAppEnv", () => {
  it("detects the deployed source tree before resolved App env reaches process.env", () => {
    assert.equal(isDatabricksAppEnv({}, "/app/python/source_code"), true);
    assert.equal(isDatabricksAppEnv({}, "/app/python/source_code/src"), true);
  });

  it("does not treat tunnel transport or an ordinary local checkout as an App runtime", () => {
    assert.equal(
      isDatabricksAppEnv(
        {
          TUNNEL_TRANSPORT: "portr",
          TUNNEL_PUBLIC_DOMAIN: "demo.apps.dbx.tools",
        },
        "/Users/example/project",
      ),
      false,
    );
  });
});
