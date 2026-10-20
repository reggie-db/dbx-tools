import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

describe("appkit-mastra package", () => {
  it("keeps Code Mode transports optional while retaining development types", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    for (const dependency of ["@mastra/isolated-vm", "@mastra/quickjs"]) {
      assert.equal(manifest.dependencies?.[dependency], undefined);
      assert.equal(manifest.optionalDependencies?.[dependency], undefined);
      assert.equal(manifest.peerDependencies?.[dependency], "catalog:");
      assert.equal(manifest.peerDependenciesMeta?.[dependency]?.optional, true);
      assert.equal(manifest.devDependencies?.[dependency], "catalog:");
    }
  });
});
