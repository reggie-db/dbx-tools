import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { addOptionalPeer, DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

it("optional peers include development resolution without becoming runtime dependencies", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const outdir = mkdtempSync(join(tmpdir(), "optional-peer-"));
  try {
    const root = new DBXToolsNodeProject({
      name: "optional-peer-fixture",
      outdir,
      defaultTagMixins: false,
    });
    const child = new DBXToolsTypeScriptProject({
      parent: root,
      outdir: "packages/addon",
      name: "@fixture/addon",
    });
    addOptionalPeer(child, "@fixture/runtime@workspace:*");
    root.synth();

    const manifest = JSON.parse(
      readFileSync(join(outdir, "packages/addon/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    assert.equal(manifest.peerDependencies?.["@fixture/runtime"], "workspace:*");
    assert.equal(manifest.peerDependenciesMeta?.["@fixture/runtime"]?.optional, true);
    assert.equal(manifest.devDependencies?.["@fixture/runtime"], "workspace:*");
    assert.equal(manifest.dependencies?.["@fixture/runtime"], undefined);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
