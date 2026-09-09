import assert from "node:assert/strict";
import test from "node:test";

import { DATABRICKS_SDK_VERSION, databricksSdkInputsFromDependencies } from "../src/inputs.ts";

test("discovers API inputs from dependencies and excludes support packages", () => {
  const inputs = databricksSdkInputsFromDependencies({
    "@databricks/sdk-auth": "catalog:",
    "@databricks/sdk-core": "catalog:",
    "@databricks/sdk-jobs": "catalog:",
    "@databricks/sdk-options": "catalog:",
    "@databricks/sdk-postgres": "catalog:",
    unrelated: "1.0.0",
  });

  assert.deepEqual(inputs, [
    {
      package: "@databricks/sdk-jobs",
      version: DATABRICKS_SDK_VERSION,
      output: "jobs",
    },
    {
      package: "@databricks/sdk-postgres",
      version: DATABRICKS_SDK_VERSION,
      output: "postgres",
    },
  ]);
});
