import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stampPythonProjects } from "../tasks/publish-python.ts";

let outdir: string;

before(() => {
  outdir = mkdtempSync(join(tmpdir(), "python-publish-"));
  for (const [directory, source] of [
    ["core", `[project]\nname = "fixture-core"\nversion = "0.0.0"\ndependencies = []\n`],
    [
      "app",
      `[project]\nname = "fixture-app"\nversion = "0.0.0"\ndependencies = ["fixture-core @ git+https://example.invalid/repo.git@main#subdirectory=python/core"]\n`,
    ],
  ] as const) {
    mkdirSync(join(outdir, directory), { recursive: true });
    writeFileSync(join(outdir, directory, "pyproject.toml"), source);
  }
});

after(() => rmSync(outdir, { recursive: true, force: true }));

describe("local Python release stamping", () => {
  it("stamps versions and sibling dependencies, then restores the workspace", () => {
    const appPath = join(outdir, "app", "pyproject.toml");
    const original = readFileSync(appPath, "utf8");
    const restore = stampPythonProjects(outdir, "1.2.3");
    const stamped = readFileSync(appPath, "utf8");
    assert.match(stamped, /version = "1\.2\.3"/);
    assert.match(stamped, /fixture-core==1\.2\.3/);
    restore();
    assert.equal(readFileSync(appPath, "utf8"), original);
  });
});
