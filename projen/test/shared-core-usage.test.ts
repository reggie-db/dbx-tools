import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { duplicatedOwnedHelpers, sharedCoreExportUsage } from "../src/shared-core-usage.ts";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("shared-core usage", () => {
  it("keeps every runtime export referenced", async () => {
    const unused = (await sharedCoreExportUsage(workspaceRoot))
      .filter((row) => row.kind === "unused")
      .map((row) => row.id);
    assert.deepEqual(unused, []);
  });

  it("rejects local copies of owned helpers", async () => {
    assert.deepEqual(await duplicatedOwnedHelpers(workspaceRoot), []);
  });
});
