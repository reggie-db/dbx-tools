import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "smol-toml";
import { preparePythonProjectForPublication } from "../tasks/lib/python-release.ts";
import { buildPythonProjects, pythonDistributionPaths } from "../tasks/publish-python.ts";

describe("Python release packaging", () => {
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

  it("projects sibling registry dependencies without changing the release version", () => {
    const prepared = preparePythonProjectForPublication(
      `[project]\nname = "fixture-app"\nversion = "1.2.3"\ndependencies = ["fixture-core"]\n`,
      {
        packages: [{ directory: "core", name: "fixture-core" }],
        toml: { parse, stringify },
        version: "1.2.3",
      },
    );
    assert.deepEqual((parse(prepared) as { project: unknown }).project, {
      name: "fixture-app",
      version: "1.2.3",
      dependencies: ["fixture-core==1.2.3"],
    });
  });

  it("rejects a package whose generated version differs from the release", () => {
    assert.throws(
      () =>
        preparePythonProjectForPublication(
          `[project]\nname = "fixture-core"\nversion = "0.0.0"\ndependencies = []\n`,
          {
            packages: [],
            toml: { parse, stringify },
            version: "1.2.3",
          },
        ),
      /does not match release 1\.2\.3/,
    );
  });

  it("rejects an unknown selected package before building", () => {
    const root = mkdtempSync(join(tmpdir(), "python-projects-"));
    const output = join(root, "dist");
    try {
      const project = join(root, "core");
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, "pyproject.toml"),
        '[project]\nname = "fixture-core"\nversion = "1.2.3"\ndependencies = []\n',
      );
      assert.throws(
        () =>
          buildPythonProjects({
            output,
            packages: ["missing"],
            root,
            version: "1.2.3",
          }),
        /Unknown Python packages: missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
