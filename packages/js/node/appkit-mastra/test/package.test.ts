import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

describe("appkit-mastra package", () => {
  it("keeps Code Mode transports optional while retaining development types", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    assert.equal(manifest.dependencies?.["@mastra/isolated-vm"], undefined);
    assert.equal(manifest.dependencies?.["@mastra/quickjs"], undefined);
    assert.equal(manifest.optionalDependencies?.["@mastra/isolated-vm"], "catalog:");
    assert.equal(manifest.optionalDependencies?.["@mastra/quickjs"], "catalog:");
    assert.equal(manifest.devDependencies?.["@mastra/isolated-vm"], "catalog:");
    assert.equal(manifest.devDependencies?.["@mastra/quickjs"], "catalog:");
  });
});
