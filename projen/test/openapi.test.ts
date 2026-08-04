import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { speakeasyOpenapiAssetName } from "../src/openapi.ts";

describe("speakeasyOpenapiAssetName", () => {
  it("maps supported release targets", () => {
    assert.equal(speakeasyOpenapiAssetName("darwin", "arm64"), "openapi_Darwin_arm64.tar.gz");
    assert.equal(speakeasyOpenapiAssetName("linux", "x64"), "openapi_Linux_x86_64.tar.gz");
    assert.equal(speakeasyOpenapiAssetName("win32", "x64"), "openapi_Windows_x86_64.zip");
  });

  it("rejects unsupported release targets", () => {
    assert.throws(
      () => speakeasyOpenapiAssetName("aix", "ppc64"),
      /no supported release asset for aix\/ppc64/,
    );
  });
});
