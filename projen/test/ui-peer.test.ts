import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";
import { PACKAGE_TAG_MIXINS } from "../src/tags.ts";

it("generates React libraries with peer-owned runtimes", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const outdir = mkdtempSync(join(tmpdir(), "ui-peer-"));
  try {
    const root = new DBXToolsNodeProject({
      name: "ui-peer-fixture",
      outdir,
      defaultTagMixins: false,
    });
    new DBXToolsTypeScriptProject({
      parent: root,
      outdir: "packages/ui/example",
      name: "@fixture/ui-example",
      tags: ["ui"],
    }).with(PACKAGE_TAG_MIXINS.ui);
    root.synth();

    const manifest = JSON.parse(
      readFileSync(join(outdir, "packages/ui/example/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    assert.equal(manifest.peerDependencies?.react, "catalog:");
    assert.equal(manifest.peerDependencies?.["react-dom"], "catalog:");
    assert.equal(manifest.devDependencies?.react, "catalog:");
    assert.equal(manifest.devDependencies?.["react-dom"], "catalog:");
    assert.equal(manifest.dependencies?.react, undefined);
    assert.equal(manifest.dependencies?.["react-dom"], undefined);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
