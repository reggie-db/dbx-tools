/**
 * Direct imports of the legacy Databricks SDK stay confined to the few
 * compatibility boundaries that need APIs AppKit does not expose.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { find } from "@dbx-tools/path";

const ROOT = resolve(import.meta.dirname, "../..");
const ALLOWED = new Set([
  "packages/js/node/appkit/src/databricks.ts",
  "packages/js/node/search/src/client.ts",
]);
const SDK_IMPORT = /^\s*import\b[^\n]*["']@databricks\/sdk-experimental["']/m;

describe("Databricks SDK boundary", () => {
  it("rejects direct imports outside compatibility modules", () => {
    const imports = [
      ...find.findFiles("packages/js/**/*.ts", {
        cwd: ROOT,
        ignoreOptions: { test: false },
      }),
    ].filter((file) => SDK_IMPORT.test(readFileSync(resolve(ROOT, file), "utf8")));

    assert.deepEqual(imports.sort(), [...ALLOWED].sort());
  });
});
