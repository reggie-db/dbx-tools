import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releasePlatformFilter } from "../src/_release-platform.ts";

describe("releasePlatformFilter", () => {
  it("crosses every repeated operating system with every architecture", () => {
    assert.equal(
      releasePlatformFilter(["linux", "darwin"], ["x64", "arm64"]),
      "linux:x64,linux:arm64,darwin:x64,darwin:arm64",
    );
  });

  it("returns an empty filter when neither selector is present", () => {
    assert.equal(releasePlatformFilter([], []), "");
  });

  it("requires operating systems and architectures together", () => {
    assert.throws(
      () => releasePlatformFilter(["linux"], []),
      /--os and --arch must be used together/,
    );
    assert.throws(
      () => releasePlatformFilter([], ["x64"]),
      /--os and --arch must be used together/,
    );
  });
});
