import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { recordedRoots } from "../src/packages.ts";
import { DBXToolsNodeProject } from "../src/project.ts";

let outdir: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "packages-"));
  mkdirSync(join(outdir, "packages/js/example/src"), { recursive: true });
  mkdirSync(join(outdir, "packages/py/example/src"), { recursive: true });
  writeFileSync(join(outdir, "packages/js/example/src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(outdir, "packages/py/example/src/example.py"), "value = 1\n");
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("recordedRoots", () => {
  it("returns configured package roots without widening to packages", () => {
    const project = new DBXToolsNodeProject({
      name: "fixture",
      outdir,
      packageRoots: ["packages/js"],
      defaultTagMixins: false,
      github: false,
    });

    project.synth();

    const manifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      dbxToolsConfig?: { packageRoots?: string[] };
    };
    assert.deepEqual(manifest.dbxToolsConfig?.packageRoots, ["packages/js"]);
    assert.deepEqual(recordedRoots(outdir), ["packages/js"]);
  });
});
