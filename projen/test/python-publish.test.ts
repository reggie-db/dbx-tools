import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "smol-toml";
import { pythonDistributionPaths, stampPythonProjects } from "../tasks/publish-python.ts";

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
  it("selects only publishable distributions", () => {
    const directory = mkdtempSync(join(tmpdir(), "python-distributions-"));
    try {
      for (const file of ["fixture-1.2.3.tar.gz", "fixture-1.2.3-py3-none-any.whl", ".gitignore"]) {
        writeFileSync(join(directory, file), "fixture");
      }
      assert.deepEqual(pythonDistributionPaths(directory), [
        join(directory, "fixture-1.2.3-py3-none-any.whl"),
        join(directory, "fixture-1.2.3.tar.gz"),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stamps versions and sibling dependencies, then restores the workspace", () => {
    const appPath = join(outdir, "app", "pyproject.toml");
    const original = readFileSync(appPath, "utf8");
    const restore = stampPythonProjects(outdir, "1.2.3");
    const stamped = readFileSync(appPath, "utf8");
    assert.deepEqual(parse(stamped).project, {
      name: "fixture-app",
      version: "1.2.3",
      dependencies: ["fixture-core==1.2.3"],
    });
    restore();
    assert.equal(readFileSync(appPath, "utf8"), original);
  });

  it("accepts projects already carrying the release version", () => {
    const corePath = join(outdir, "core", "pyproject.toml");
    const original = readFileSync(corePath, "utf8");
    const restore = stampPythonProjects(outdir, "0.0.0");
    assert.equal(readFileSync(corePath, "utf8"), original);
    restore();
    assert.equal(readFileSync(corePath, "utf8"), original);
  });

  it("stamps versions without replacing standalone Git dependencies when asked", () => {
    const appPath = join(outdir, "app", "pyproject.toml");
    const original = readFileSync(appPath, "utf8");
    const restore = stampPythonProjects(outdir, "1.2.3", {
      rewriteDependencies: false,
    });
    const stamped = parse(readFileSync(appPath, "utf8")).project as {
      dependencies: string[];
      version: string;
    };
    assert.equal(stamped.version, "1.2.3");
    assert.deepEqual(stamped.dependencies, [
      "fixture-core @ git+https://example.invalid/repo.git@main#subdirectory=python/core",
    ]);
    assert.deepEqual([...restore.paths].sort(), [
      join(outdir, "app", "pyproject.toml"),
      join(outdir, "core", "pyproject.toml"),
    ]);
    restore();
    assert.equal(readFileSync(appPath, "utf8"), original);
  });

  it("restores every project when structured stamping fails", () => {
    const appPath = join(outdir, "app", "pyproject.toml");
    const corePath = join(outdir, "core", "pyproject.toml");
    const appOriginal = readFileSync(appPath, "utf8");
    const coreOriginal = readFileSync(corePath, "utf8");
    writeFileSync(corePath, `[project]\nname = "fixture-core"\ndependencies = []\n`);
    assert.throws(() => stampPythonProjects(outdir, "1.2.3"), /Missing Python project version/);
    assert.equal(readFileSync(appPath, "utf8"), appOriginal);
    assert.equal(
      readFileSync(corePath, "utf8"),
      `[project]\nname = "fixture-core"\ndependencies = []\n`,
    );
    writeFileSync(corePath, coreOriginal);
  });
});
