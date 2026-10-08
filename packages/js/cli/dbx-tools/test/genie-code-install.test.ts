import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GENIE_CODE_VERSION } from "@dbx-tools/shared-genie-code/options";

import { genieCodeAsset } from "../src/genie-code/install.ts";

describe("Genie Code release assets", () => {
  it("pins the exact release target and digest for each supported host", () => {
    assert.deepEqual(genieCodeAsset("darwin", "arm64"), {
      target: "aarch64-apple-darwin",
      sha256: "78cc7e358c8bfc62d6da26364c762be37fc2e2a10b7e83f21a3b166f901f528e",
    });
    assert.deepEqual(genieCodeAsset("linux", "x64"), {
      target: "x86_64-unknown-linux-musl",
      sha256: "e3d9a55f6d51bdc745eda4744fb827ba1df6dacf1069518f7347a59f48c89430",
    });
    assert.equal(GENIE_CODE_VERSION, "0.1.0-beta.2");
  });

  it("fails closed on unsupported platforms", () => {
    assert.throws(() => genieCodeAsset("aix", "x64"), /does not support aix\/x64/);
  });
});
