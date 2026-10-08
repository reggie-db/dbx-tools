import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { duplicatedOwnedHelpers, sharedCoreExportUsage } from "../src/shared-core-usage.ts";

describe("shared-core usage", () => {
  it("keeps every runtime export referenced", () => {
    const unused = sharedCoreExportUsage()
      .filter((row) => row.kind === "unused")
      .map((row) => row.id);
    assert.deepEqual(unused, []);
  });

  it("rejects local copies of owned helpers", () => {
    assert.deepEqual(duplicatedOwnedHelpers(), []);
  });
});
