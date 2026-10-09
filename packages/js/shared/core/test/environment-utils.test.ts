import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { environmentUtils } from "../index.ts";

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
      environmentUtils.isDatabricksAppEnv({
        DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
      }),
      false,
    );
    assert.equal(
      environmentUtils.isDatabricksAppEnv({
        DATABRICKS_APP_NAME: "${var.app_name}",
        DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
      }),
      false,
    );
  });

  it("validates DATABRICKS_APP_PORT only when it is present", () => {
    const source = {
      DATABRICKS_APP_NAME: "dbx-tools-demo",
      DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
    };
    assert.equal(environmentUtils.isDatabricksAppEnv({ ...source, DATABRICKS_APP_PORT: "8000" }), true);
    assert.equal(environmentUtils.isDatabricksAppEnv({ ...source, DATABRICKS_APP_PORT: "bad" }), false);
  });
});
