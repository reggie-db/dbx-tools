import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DBXToolsNodeProject } from "../src/project.ts";

function fixture(packageDescriptions: Readonly<Record<string, string>>) {
  const outdir = mkdtempSync(join(tmpdir(), "package-metadata-"));
  mkdirSync(join(outdir, "packages/example/src"), { recursive: true });
  writeFileSync(join(outdir, "packages/example/src/example.ts"), "export const value = 1;\n");
  const project = new DBXToolsNodeProject({
    name: "fixture",
    scope: "fixture",
    outdir,
    packageRoots: ["packages"],
    omitRelativePrefix: [],
    defaultTagMixins: false,
    github: false,
    packageDescriptions,
  });
  return { outdir, project };
}

describe("published package metadata", () => {
  it("generates descriptions and Apache licenses", () => {
    const { outdir, project } = fixture({ "packages/example": "Fixture package" });
    try {
      project.synth();
      const manifest = JSON.parse(
        readFileSync(join(outdir, "packages/example/package.json"), "utf8"),
      ) as { description?: string; license?: string };
      assert.equal(manifest.description, "Fixture package");
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal(existsSync(join(outdir, "LICENSE")), true);
      assert.equal(existsSync(join(outdir, "packages/example/LICENSE")), true);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("rejects public packages without descriptions", () => {
    const { outdir, project } = fixture({});
    try {
      assert.throws(
        () => project.synth(),
        /Published package packages\/example requires a non-empty description/,
      );
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
