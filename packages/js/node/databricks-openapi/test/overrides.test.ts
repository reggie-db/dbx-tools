import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractSdkSources } from "../src/ast.ts";
import { applyOverrides } from "../src/overrides.ts";
import { renderOpenapi, stringifyOpenapi } from "../src/render.ts";
import { DatabricksOpenapiError } from "../src/types.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SDK_DIRECTORY = join(TEST_DIRECTORY, "fixtures", "sdk");
const RAW_OVERRIDE = {
  reason: "The SDK returns the response body directly.",
  source: "test/fixtures/sdk/client.js",
  status: "200",
  responseMediaType: "application/octet-stream",
  rawResponse: "binary" as const,
};

function fixtureIr() {
  return extractSdkSources({
    input: {
      package: "@fixtures/sdk-widgets",
      output: "widgets",
      expectedOperations: 3,
    },
    packageVersion: "1.2.3",
    clientSource: readFileSync(join(SDK_DIRECTORY, "client.js"), "utf8"),
    modelSource: readFileSync(join(SDK_DIRECTORY, "model.js"), "utf8"),
    strict: true,
  });
}

test("applies a narrow raw response override", () => {
  const ir = fixtureIr();
  applyOverrides(
    [ir],
    {
      version: 1,
      operations: {
        "widget.downloadWidget": RAW_OVERRIDE,
      },
    },
    true,
  );

  const raw = ir.operations.find((operation) => operation.methodName === "downloadWidget");
  assert.equal(raw?.response.mediaType, "application/octet-stream");
  assert.deepEqual(raw?.response.rawSchema, { type: "string", format: "binary" });
});

test("fails when an override no longer matches an operation", () => {
  const ir = fixtureIr();
  assert.throws(
    () =>
      applyOverrides(
        [ir],
        {
          version: 1,
          operations: {
            "widget.removedOperation": RAW_OVERRIDE,
            "widget.downloadWidget": RAW_OVERRIDE,
          },
        },
        true,
      ),
    (error) => {
      assert.ok(error instanceof DatabricksOpenapiError);
      assert.match(error.message, /STALE_OVERRIDE/);
      return true;
    },
  );
});

test("renders deterministic OpenAPI without machine paths or timestamps", () => {
  const ir = fixtureIr();
  applyOverrides(
    [ir],
    {
      version: 1,
      operations: {
        "widget.downloadWidget": RAW_OVERRIDE,
      },
    },
    true,
  );
  const first = stringifyOpenapi(renderOpenapi(ir));
  const second = stringifyOpenapi(renderOpenapi(ir));

  assert.equal(first, second);
  assert.doesNotMatch(first, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(first, /generatedAt|timestamp/i);
  const document = JSON.parse(first);
  assert.deepEqual(
    document["x-databricks-operation-inventory"].map(
      (entry: { operationId: string }) => entry.operationId,
    ),
    ["widget.createWidget", "widget.downloadWidget", "widget.uploadWidget"],
  );
});
