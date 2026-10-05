import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

function fixture(description?: string) {
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
  });
  const example = project.subprojects[0] as DBXToolsTypeScriptProject;
  if (description) example.package.addField("description", description);
  example.addDeps("@fixture/shared-core@workspace:^");
  return { outdir, project };
}

describe("published package metadata", () => {
  it("generates descriptions and Apache licenses", () => {
    const { outdir, project } = fixture("Fixture package");
    try {
      project.synth();
      const manifest = JSON.parse(
        readFileSync(join(outdir, "packages/example/package.json"), "utf8"),
      ) as {
        description?: string;
        license?: string;
        dependencies?: Record<string, string>;
      };
      assert.equal(manifest.description, "Fixture package");
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal(manifest.dependencies?.["@fixture/shared-core"], "workspace:^");
      assert.equal(existsSync(join(outdir, "LICENSE")), true);
      assert.equal(existsSync(join(outdir, "packages/example/LICENSE")), true);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
