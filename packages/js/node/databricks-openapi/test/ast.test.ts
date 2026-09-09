import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractResolvedSdk, extractSdkSources } from "../src/ast.ts";
import { resolveSdkInput } from "../src/config.ts";
import { discoverDatabricksSdkInputs } from "../src/inputs.ts";
import { DatabricksOpenapiError, type DatabricksSdkInput } from "../src/types.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = join(TEST_DIRECTORY, "fixtures", "sdk");
const ROOT_PACKAGE_JSON = join(TEST_DIRECTORY, "../../../../../package.json");
const INPUT: DatabricksSdkInput = {
  package: "@fixtures/sdk-widgets",
  output: "widgets",
  expectedOperations: 3,
};

function fixtureSources() {
  return {
    clientSource: readFileSync(join(FIXTURE_DIRECTORY, "client.js"), "utf8"),
    modelSource: readFileSync(join(FIXTURE_DIRECTORY, "model.js"), "utf8"),
  };
}

test("extracts direct operations and wire schemas from generated AST", () => {
  const ir = extractSdkSources({
    input: INPUT,
    packageVersion: "1.2.3",
    ...fixtureSources(),
    strict: true,
  });

  assert.deepEqual(
    ir.operations.map((operation) => operation.operationId),
    ["widget.createWidget", "widget.downloadWidget", "widget.uploadWidget"],
  );
  const create = ir.operations.find((operation) => operation.methodName === "createWidget");
  assert.equal(create?.httpMethod, "POST");
  assert.equal(create?.body?.sourcePath, "widget");
  assert.deepEqual(
    create?.parameters.map((parameter) => [
      parameter.location,
      parameter.sdkName,
      parameter.wireName,
    ]),
    [
      ["query", "view", "view"],
      ["path", "parent", "parent"],
    ],
  );

  const widget = ir.schemas.get("Widget");
  assert.equal(
    (widget?.schema.properties as Record<string, Record<string, unknown>>).created_at?.format,
    "date-time",
  );
  assert.equal(widget?.sdkToWire.displayName, "display_name");
  const upload = ir.schemas.get("UploadRequest");
  assert.deepEqual(
    Object.keys((upload?.schema.properties as Record<string, unknown>) ?? {}).sort(),
    ["content_bytes", "inline", "metadata", "name", "uri"],
  );
});

test("reports unsupported Zod syntax with a source location", () => {
  const sources = fixtureSources();
  assert.throws(
    () =>
      extractSdkSources({
        input: INPUT,
        packageVersion: "1.2.3",
        clientSource: sources.clientSource,
        modelSource: sources.modelSource.replace(
          "z.string(),\n    display_name",
          "z.date(),\n    display_name",
        ),
        strict: true,
      }),
    (error) => {
      assert.ok(error instanceof DatabricksOpenapiError);
      assert.match(error.message, /dist\/v1\/model\.js:\d+:\d+/);
      assert.match(error.message, /UNSUPPORTED_ZOD_SYNTAX/);
      return true;
    },
  );
});

test("extracts the complete pinned SDK operation inventories", () => {
  const inputs = discoverDatabricksSdkInputs();
  let operations = 0;
  for (const pinned of inputs) {
    const input: DatabricksSdkInput = {
      package: pinned.package,
      output: pinned.output,
      expectedOperations: pinned.expectedOperations,
    };
    const resolved = resolveSdkInput(input, ROOT_PACKAGE_JSON);
    const ir = extractResolvedSdk(resolved, true);
    operations += ir.operations.length;
    if (pinned.output === "postgres") {
      const getCatalog = ir.operations.find(
        (operation) => operation.operationId === "postgres.getCatalog",
      );
      assert.equal(getCatalog?.path, "/api/2.0/postgres/catalogs/{catalog_id}");
    }
  }
  assert.equal(inputs.length, 82);
  assert.equal(operations, 939);
});
