import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DBXToolsNodeProject,
  DBXToolsPythonWorkspace,
  pythonGitDependency,
} from "../src/project.ts";

let outdir: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "project-py-"));
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("DBXToolsPythonWorkspace", () => {
  it("reuses project.vscode and emits a configurable uv workspace", () => {
    const project = new DBXToolsNodeProject({
      name: "fixture",
      outdir,
      defaultTagMixins: false,
      github: true,
    });
    assert.equal(project.vsCode?.vsCode, project.vscode);

    const repository = {
      url: "https://github.com/example/fixture.git",
      ref: "main",
      root: "python/packages",
    } as const;
    new DBXToolsPythonWorkspace(project, {
      repository,
      packages: [
        {
          directory: "core",
          name: "fixture-core",
          module: "fixture.core",
          description: "Fixture core",
        },
        {
          directory: "app",
          name: "fixture-app",
          module: "fixture.app",
          description: "Fixture app",
          dependencies: [pythonGitDependency(repository, "fixture-core", "core")],
        },
        {
          directory: "native",
          name: "fixture-native",
          module: "fixture.native",
          description: "Private native package",
          private: true,
        },
      ],
      dependencies: ["fixture-app"],
      requiresPython: ">=3.12",
      indexStrategy: "unsafe-best-match",
      ruffTarget: "py312",
      lintPaths: ["python"],
      pyreflyProjectExcludes: ["python/packages/native/src/fixture/native/bindings.py"],
      interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
      release: true,
    });

    project.synth();

    const workspace = readFileSync(join(outdir, "pyproject.toml"), "utf8");
    assert.match(workspace, /members = \[\s*"python\/packages\/\*"\s*\]/);
    assert.doesNotMatch(workspace, /exclude =/);
    assert.match(workspace, /\[tool\.uv\.sources\.fixture-native\]\s+workspace = true/);
    assert.match(workspace, /dependencies = \[\s*"fixture-app"\s*\]/);
    assert.match(workspace, /requires-python = ">=3\.12"/);
    assert.match(workspace, /index-strategy = "unsafe-best-match"/);
    assert.match(workspace, /target[_-]version = "py312"/);
    assert.match(workspace, /\[tool\.pyrefly\]\s+ignore-errors-in-generated-code = true/);
    assert.match(
      workspace,
      /project-excludes = \["python\/packages\/native\/src\/fixture\/native\/bindings\.py"\]/,
    );
    assert.doesNotMatch(workspace, /^  \[/m);
    assert.doesNotMatch(workspace, /= \[ /);

    const app = readFileSync(join(outdir, "python/packages/app/pyproject.toml"), "utf8");
    assert.match(
      app,
      /fixture-core @ git\+https:\/\/github\.com\/example\/fixture\.git@main#subdirectory=python\/packages\/core/,
    );
    assert.doesNotMatch(app, /\[dependency-groups\]/);
    assert.doesNotMatch(app, /^  \[/m);
    assert.doesNotMatch(app, /= \[ /);
    const native = readFileSync(join(outdir, "python/packages/native/pyproject.toml"), "utf8");
    assert.match(native, /\[tool\.dbx-tools\]\s+private = true/);

    const settings = readFileSync(join(outdir, ".vscode/settings.json"), "utf8");
    assert.match(settings, /python\/\.venv\/bin\/python/);
    const packageJson = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    assert.doesNotMatch(
      readFileSync(join(outdir, "pnpm-workspace.yaml"), "utf8"),
      /python\/packages/,
    );
    assert.ok(!packageJson.workspaces?.some((member) => member.startsWith("python/packages/")));
    const release = readFileSync(join(outdir, ".github/workflows/python-release.yml"), "utf8");
    assert.match(release, /^    tags:\n      - v\*$/m);
    assert.match(
      release,
      /VERSION: \$\{\{ github\.event_name == 'push' && github\.ref_name \|\| inputs\.version \}\}/,
    );
    assert.match(release, /version = os\.environ\["VERSION"\]\.removeprefix\("v"\)/);
    assert.match(release, /^  publish-core:$/m);
    assert.match(release, /^      name: pypi-fixture-core$/m);
    assert.match(release, /^          packages-dir: dist\/core$/m);
    assert.match(release, /^  publish-app:$/m);
    assert.match(release, /^      name: pypi-fixture-app$/m);
    assert.match(release, /^          packages-dir: dist\/app$/m);
    assert.match(release, /if: \$\{\{ github\.event_name == 'push' \}\}/);
    assert.doesNotMatch(release, /inputs\.publish/);
    assert.doesNotMatch(release, /^  publish:$/m);
    assert.doesNotMatch(release, /publish-native/);
    assert.ok(project.tasks.tryFind("py:sync"));
    assert.ok(project.tasks.tryFind("py:build"));
  });
});
