import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { environmentUtils } from "../index.ts";

const LOCAL_CWD = "/Users/example/project";

interface AppEnvironmentFixture {
  name: string;
  environment: Record<string, string>;
  detected: boolean;
}

describe("isDatabricksAppEnv", () => {
  it("detects deployed Apps when the platform omits DATABRICKS_APP_PORT", () => {
    assert.equal(
      environmentUtils.isDatabricksAppEnv({
        DATABRICKS_APP_NAME: "dbx-tools-demo",
        DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
      }),
      true,
    );
  });

  it("retains host and port detection when the platform omits DATABRICKS_APP_NAME", () => {
    assert.equal(
      environmentUtils.isDatabricksAppEnv({
        DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
        DATABRICKS_APP_PORT: "8000",
      }),
      true,
    );
  });

  it("rejects local and unresolved bundle environments", () => {
    assert.equal(
      environmentUtils.isDatabricksAppEnv(
        {
          DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
        },
        LOCAL_CWD,
      ),
      false,
    );
    assert.equal(
      environmentUtils.isDatabricksAppEnv(
        {
          DATABRICKS_APP_NAME: "${var.app_name}",
          DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
        },
        LOCAL_CWD,
      ),
      false,
    );
  });

  it("validates DATABRICKS_APP_PORT only when it is present", () => {
    const source = {
      DATABRICKS_APP_NAME: "dbx-tools-demo",
      DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
    };
    assert.equal(
      environmentUtils.isDatabricksAppEnv({ ...source, DATABRICKS_APP_PORT: "8000" }),
      true,
    );
    assert.equal(
      environmentUtils.isDatabricksAppEnv({ ...source, DATABRICKS_APP_PORT: "bad" }, LOCAL_CWD),
      false,
    );
  });

  it("matches the shared runtime fixtures", () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "../../../../test/fixtures/config/databricks-app-environments.json",
    );
    const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as AppEnvironmentFixture[];
    for (const fixture of fixtures) {
      assert.equal(
        environmentUtils.isDatabricksAppEnv(fixture.environment, LOCAL_CWD),
        fixture.detected,
        fixture.name,
      );
    }
  });

  it("detects the deployed source tree before resolved App env reaches process.env", () => {
    assert.equal(
      environmentUtils.isDatabricksAppEnv({}, environmentUtils.DATABRICKS_APP_SOURCE_ROOT),
      true,
    );
    assert.equal(
      environmentUtils.isDatabricksAppEnv(
        {},
        `${environmentUtils.DATABRICKS_APP_SOURCE_ROOT}/src`,
      ),
      true,
    );
  });

  it("does not treat tunnel transport or an ordinary local checkout as an App runtime", () => {
    assert.equal(
      environmentUtils.isDatabricksAppEnv(
        {
          TUNNEL_TRANSPORT: "portr",
          TUNNEL_PUBLIC_DOMAIN: "demo.apps.dbx.tools",
        },
        LOCAL_CWD,
      ),
      false,
    );
  });
});
