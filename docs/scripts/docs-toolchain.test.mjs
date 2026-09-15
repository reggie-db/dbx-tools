import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadDocsToolchain } from "./docs-toolchain.mjs";

const complete = {
  "@astrojs/starlight": "0.41.11",
  astro: "7.3.2",
  typedoc: "0.28.20",
  "typedoc-plugin-markdown": "4.13.0",
};

function withToolchain(value, callback) {
  const dir = mkdtempSync(join(tmpdir(), "docs-toolchain-"));
  const file = join(dir, "toolchain.json");
  try {
    writeFileSync(file, JSON.stringify(value));
    callback(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("documentation toolchain", () => {
  it("accepts the complete exact-version set", () => {
    withToolchain(complete, (file) => assert.deepEqual(loadDocsToolchain(file), complete));
  });

  it("rejects version ranges", () => {
    withToolchain({ ...complete, astro: "^7.3.2" }, (file) => {
      assert.throws(() => loadDocsToolchain(file), /astro requires an exact version/);
    });
  });
});
