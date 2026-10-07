import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "smol-toml";
import { buildPythonProjects, pythonDistributionPaths } from "../tasks/publish-python.ts";
import { preparePythonProjectForPublication } from "../tasks/python-release.ts";

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

  it("keeps explicit build output inside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "python-projects-"));
    try {
      assert.throws(
        () =>
          buildPythonProjects({
            allowEmpty: true,
            output: resolve(root, "..", "..", "outside"),
            root,
            version: "1.2.3",
          }),
        /inside the workspace/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes read-only publication output after a build failure", () => {
    const root = mkdtempSync(join(tmpdir(), "python-publish-cleanup-"));
    try {
      const bin = join(root, "bin");
      const packages = join(root, "packages");
      const project = join(packages, "fixture");
      const temporaryDirectory = join(root, "temporary");
      mkdirSync(bin);
      mkdirSync(project, { recursive: true });
      mkdirSync(temporaryDirectory);
      writeFileSync(
        join(project, "pyproject.toml"),
        '[project]\nname = "fixture"\nversion = "1.2.3"\ndependencies = []\n',
      );
      writeFileSync(
        join(bin, "uv"),
        [
          "#!/bin/sh",
          'mkdir -p "$3/generated"',
          'touch "$3/generated/output.py"',
          'chmod 444 "$3/generated/output.py"',
          'chmod 555 "$3/generated"',
          "exit 7",
        ].join("\n"),
      );
      chmodSync(join(bin, "uv"), 0o755);
      const owner = resolve(import.meta.dirname, "../tasks/publish-python.ts");
      const script = [
        `import { publishPythonProjects } from ${JSON.stringify(owner)};`,
        "let failed = false;",
        "try {",
        `  publishPythonProjects(${JSON.stringify({
          indexUrl: "https://packages.example/simple",
          publishUrl: "https://packages.example/repository",
          root: packages,
          version: "1.2.3",
        })});`,
        "} catch {",
        "  failed = true;",
        "}",
        'if (!failed) throw new Error("expected publication to fail");',
      ].join("\n");
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: temporaryDirectory,
        },
        stdout: "ignore",
        stderr: "ignore",
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        readdirSync(temporaryDirectory).filter((entry) =>
          entry.startsWith("projen-python-publish-"),
        ),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
