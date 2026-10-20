import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DiscoveredPackage, recordedRoots } from "../src/packages.ts";
import { DBXToolsNodeProject } from "../src/project-js.ts";

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
  it("returns configured package roots and extra workspace member roots", () => {
    const project = new DBXToolsNodeProject({
      name: "fixture",
      outdir,
      packageRoots: ["packages/js"],
      extraWorkspaceMembers: ["tooling"],
      defaultTagMixins: false,
      github: false,
    });

    project.synth();

    const manifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      dbxToolsConfig?: { packageRoots?: string[] };
    };
    assert.deepEqual(manifest.dbxToolsConfig?.packageRoots, ["packages/js"]);
    assert.deepEqual(recordedRoots(outdir), ["packages/js", "tooling"]);
  });

  it("prefers packages/js when the conventional JavaScript root exists", () => {
    const root = mkdtempSync(join(tmpdir(), "packages-js-default-"));
    try {
      mkdirSync(join(root, "packages/js/example/src"), { recursive: true });
      writeFileSync(join(root, "packages/js/example/src/example.ts"), "export const value = 1;\n");
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: root,
        defaultTagMixins: false,
        releaseMode: "disabled",
      });
      project.synth();

      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dbxToolsConfig?: { packageRoots?: string[] };
      };
      assert.deepEqual(manifest.dbxToolsConfig?.packageRoots, ["packages/js"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("package role tags", () => {
  it("uses terminal app and server directory names as specific runtime roles", () => {
    assert.deepEqual(
      new DiscoveredPackage("/workspace", "packages/js", ["ui", "app"]).tagCandidates,
      ["app"],
    );
    assert.deepEqual(
      new DiscoveredPackage("/workspace", "packages/js", ["node", "server"]).tagCandidates,
      ["server"],
    );
    assert.deepEqual(
      new DiscoveredPackage("/workspace", "packages/js", ["shared", "investigation"]).tagCandidates,
      ["shared"],
    );
  });
});
