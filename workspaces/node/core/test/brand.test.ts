import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { brand } from "../index";

describe("brand files", () => {
  it("loads YAML and discovers the conventional branding path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-brand-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
      await mkdir(join(root, "branding"));
      await writeFile(join(root, "branding", "brand.yaml"), "name: Fixture\ncolors:\n  primary: '#123456'\n");

      assert.equal(
        brand.findBrandContextFile(root),
        join(await realpath(root), "branding", "brand.yaml"),
      );
      const context = await brand.loadBrandContext(root);
      assert.equal(context.name, "Fixture");
      assert.equal(context.colors.primary, "#123456");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads JSON and resolves relative assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-brand-"));
    try {
      const file = join(root, "brand.json");
      await writeFile(file, '{"name":"JSON Fixture"}\n');
      assert.equal((await brand.loadBrandContextFile(file)).name, "JSON Fixture");
      assert.equal(brand.resolveBrandAssetPath(file, "assets/icon.svg"), join(root, "assets", "icon.svg"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
