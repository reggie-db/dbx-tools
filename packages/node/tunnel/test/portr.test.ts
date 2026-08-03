import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { portrAssetName } from "../src/portr.ts";

describe("portrAssetName", () => {
  it("selects official Darwin and Linux architecture assets", () => {
    assert.equal(portrAssetName("1.0.13", "darwin", "arm64"), "portr_1.0.13_Darwin_arm64.zip");
    assert.equal(portrAssetName("1.0.13", "darwin", "x64"), "portr_1.0.13_Darwin_x86_64.zip");
    assert.equal(portrAssetName("1.0.13", "linux", "arm64"), "portr_1.0.13_Linux_arm64.zip");
    assert.equal(portrAssetName("1.0.13", "linux", "x64"), "portr_1.0.13_Linux_x86_64.zip");
  });

  it("rejects platforms without a published asset", () => {
    assert.throws(() => portrAssetName("1.0.13", "win32", "x64"), /no supported release asset/);
    assert.throws(() => portrAssetName("1.0.13", "linux", "riscv64"), /no supported release asset/);
  });
});
