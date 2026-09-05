import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { config } from "@dbx-tools/core";

const ENVIRONMENT_KEYS = [
  "DBX_TOOLS_DATABRICKS_APP_ENV",
  "DATABRICKS_APP_NAME",
  "DATABRICKS_HOST",
  "DATABRICKS_APP_PORT",
] as const;
const ENTRYPOINT = new URL("../index.ts", import.meta.url).href;

function rustDetection(environment: Record<string, string>): boolean {
  const env = { ...process.env };
  for (const key of ENVIRONMENT_KEYS) {
    delete env[key];
  }
  Object.assign(env, environment);
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `import { isDatabricksApp } from ${JSON.stringify(ENTRYPOINT)}; process.stdout.write(JSON.stringify(isDatabricksApp()));`,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as boolean;
}

test("Rust and Node detect the same Databricks App environments", () => {
  for (const environment of [
    {
      DATABRICKS_APP_NAME: "example",
      DATABRICKS_HOST: "https://example.cloud.databricks.com",
      DATABRICKS_APP_PORT: "8000",
    },
    {
      DBX_TOOLS_DATABRICKS_APP_ENV: "off",
      DATABRICKS_APP_NAME: "example",
      DATABRICKS_HOST: "https://example.cloud.databricks.com",
      DATABRICKS_APP_PORT: "8000",
    },
    {
      DATABRICKS_APP_NAME: "example",
      DATABRICKS_HOST: "https://example.cloud.databricks.com",
      DATABRICKS_APP_PORT: "70000",
    },
  ]) {
    assert.equal(rustDetection(environment), config.isDatabricksAppEnv(environment));
  }
});
