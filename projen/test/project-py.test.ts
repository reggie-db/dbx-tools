import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
          trustedPublisher: {
            workflowName: "rust-release",
            environment: "native-fixture-native",
            artifacts: "platform-specific wheels for all supported architectures",
          },
        },
      ],
      dependencies: ["fixture-app"],
      requiresPython: ">=3.12",
      indexStrategy: "unsafe-best-match",
      ruffTarget: "py312",
      lintPaths: ["python"],
      pyreflyProjectExcludes: ["python/packages/native/src/fixture/native/bindings.py"],
      interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
      release: {
        workflowName: "publish-python",
        environments: { "fixture-app": "production-pypi" },
      },
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
    const release = readFileSync(join(outdir, ".github/workflows/publish-python.yml"), "utf8");
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
    assert.match(release, /^      name: production-pypi$/m);
    assert.match(release, /^          packages-dir: dist\/app$/m);
    assert.match(release, /if: \$\{\{ github\.event_name == 'push' \}\}/);
    assert.doesNotMatch(release, /inputs\.publish/);
    assert.doesNotMatch(release, /^  publish:$/m);
    assert.doesNotMatch(release, /publish-native/);
    const instructionsTask = project.tasks.tryFind("pypiTrustedPublisherInstructions");
    const instructionsCommand = instructionsTask?.steps?.[0]?.exec;
    assert.equal(instructionsCommand, "node .projen/pypi-trusted-publisher-instructions.mjs");
    const helper = join(outdir, ".projen/pypi-trusted-publisher-instructions.mjs");
    const result = spawnSync(process.execPath, [helper, "--secretFile", "/run/secrets/pypi.json"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const instructions = result.stdout;
    assert.match(instructions, /PyPI project: fixture-core/);
    assert.match(instructions, /GitHub repository: example\/fixture/);
    assert.match(instructions, /GitHub environment: pypi-fixture-core/);
    assert.match(instructions, /PyPI project: fixture-app/);
    assert.match(instructions, /GitHub environment: production-pypi/);
    assert.match(instructions, /Workflow filename: publish-python\.yml/);
    assert.match(instructions, /Workflow path: \.github\/workflows\/publish-python\.yml/);
    assert.match(instructions, /read credentials from \/run\/secrets\/pypi\.json/);
    assert.match(instructions, /pause and ask the user to complete every CAPTCHA/i);
    assert.match(instructions, /PyPI project: fixture-native/);
    assert.match(instructions, /GitHub environment: native-fixture-native/);
    assert.match(instructions, /Workflow filename: rust-release\.yml/);
    assert.match(instructions, /Artifacts: platform-specific wheels/);
    assert.match(instructions, /do not require separate PyPI projects or trusted publishers/);
    assert.ok(project.tasks.tryFind("py:sync"));
    assert.ok(project.tasks.tryFind("py:build"));
  });
});
