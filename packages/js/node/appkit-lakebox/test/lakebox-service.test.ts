import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testScript = fileURLToPath(new URL("./lakebox_service_test.py", import.meta.url));

describe("Lakebox service controller", () => {
  it("preserves state, dispatch, and namespace behavior", () => {
    const result = spawnSync(process.env.PYTHON ?? "python3", [testScript], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});
