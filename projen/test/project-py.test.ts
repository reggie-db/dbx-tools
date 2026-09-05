import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readWorkflow, workflowStep } from "./workflow.ts";
import {
  DBXToolsNodeProject,
  DBXToolsPythonWorkspace,
  DBXToolsRustWorkspace,
  RustReleaseCpu,
  RustReleaseOs,
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
      repository: "https://github.com/example/fixture.git",
    });
    assert.equal(project.vsCode?.vsCode, project.vscode);

    mkdirSync(join(outdir, "native-rust/native/src"), { recursive: true });
    writeFileSync(join(outdir, "native-rust/native/src/lib.rs"), "uniffi::setup_scaffolding!();\n");
    const rust = new DBXToolsRustWorkspace(project, {
      root: "native-rust",
      nodeRoot: "node/packages",
      pythonRoot: "python/packages",
      releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      packages: { native: { bindings: ["python"] } },
    });
    new DBXToolsPythonWorkspace(project, {
      root: "python/packages",
      packages: [
        {
          directory: "core",
          description: "Fixture core",
        },
        {
          directory: "app",
          description: "Fixture app",
          internalDependencies: ["core"],
        },
        {
          directory: "standard",
          description: "Explicit standard publisher package",
          uniffi: false,
        },
        ...rust.pythonPackages,
      ],
      dependencies: ["fixture-app"],
      requiresPython: ">=3.12",
      indexStrategy: "unsafe-best-match",
      ruffTarget: "py312",
      lintPaths: ["python"],
      interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
      release: { environments: { "fixture-app": "production-pypi" } },
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
      /project-excludes = \[[^\]]*"python\/packages\/native\/src\/fixture\/native\/bindings\.py"/,
    );
    assert.doesNotMatch(workspace, /^  \[/m);
    assert.doesNotMatch(workspace, /= \[ /);
    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.venv\/$/m);
    assert.match(gitignore, /^python\/packages\/\*\*\/dist\/$/m);

    const app = readFileSync(join(outdir, "python/packages/app/pyproject.toml"), "utf8");
    assert.match(
      app,
      /fixture-core @ git\+https:\/\/github\.com\/example\/fixture\.git@main#subdirectory=python\/packages\/core/,
    );
    assert.doesNotMatch(app, /\[dependency-groups\]/);
    assert.doesNotMatch(app, /^  \[/m);
    assert.doesNotMatch(app, /= \[ /);
    const native = readFileSync(join(outdir, "python/packages/native/pyproject.toml"), "utf8");
    assert.match(native, /\[tool\.dbx_tools\.config\]\s+uniffi = true/);
    const standard = readFileSync(join(outdir, "python/packages/standard/pyproject.toml"), "utf8");
    assert.match(standard, /\[tool\.dbx_tools\.config\]\s+uniffi = false/);

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
    const release = readWorkflow(outdir);
    assert.ok(release.jobs["rust-build"]);
    const buildPython = release.jobs["build-python"]!;
    assert.deepEqual(buildPython.needs, ["verify-context", "rust-build"]);
    assert.equal(buildPython.env?.BUN_VERSION, "1.3.14");
    assert.equal(workflowStep(buildPython, "Restore Bun cache").uses, "actions/cache/restore@v5");
    assert.equal(workflowStep(buildPython, "Save Bun cache").uses, "actions/cache/save@v5");
    assert.ok(
      workflowStep(buildPython, "Stamp workspace versions").run?.includes("stamp-python.ts"),
    );
    assert.equal(
      workflowStep(buildPython, "Download fixture-native native wheels").with?.pattern,
      "fixture-native--*--python-wheel",
    );
    assert.deepEqual(release.jobs["publish-pypi-core"]?.environment, {
      name: "pypi-fixture-core",
      url: "https://pypi.org/project/fixture-core/",
    });
    assert.equal(
      workflowStep(release.jobs["publish-pypi-core"]!, "Publish fixture-core to PyPI").with?.[
        "packages-dir"
      ],
      "dist/core",
    );
    assert.ok(release.jobs["publish-pypi-standard"]);
    assert.deepEqual(release.jobs["publish-pypi-app"]?.environment, {
      name: "production-pypi",
      url: "https://pypi.org/project/fixture-app/",
    });
    assert.equal(release.jobs["publish-pypi-native"]?.if, "${{ github.event_name == 'push' }}");
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);
    const instructionsTask = project.tasks.tryFind("pypiTrustedPublisherInstructions");
    const instructionsCommand = instructionsTask?.steps?.[0]?.exec;
    assert.equal(instructionsCommand, "node .projen/pypi-trusted-publisher-instructions.mjs");
    const helper = join(outdir, ".projen/pypi-trusted-publisher-instructions.mjs");
    const result = spawnSync(process.execPath, [helper, "--secretFile", "/run/secrets/pypi.json"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const instructions = result.stdout;
    assert.match(
      instructions,
      /## fixture-core\n- Owner: example\n- Repository name: fixture\n- Workflow name: release\.yml\n- Environment name: pypi-fixture-core/,
    );
    assert.match(
      instructions,
      /## fixture-app\n- Owner: example\n- Repository name: fixture\n- Workflow name: release\.yml\n- Environment name: production-pypi/,
    );
    assert.match(instructions, /Before making any changes, complete a read-only audit/);
    assert.match(instructions, /active PyPI account can administer the listed projects/);
    assert.doesNotMatch(instructions, /active PyPI account is example/);
    assert.match(instructions, /proposed reconciliation plan grouped by publishers/);
    assert.match(instructions, /confirm the complete proposed plan before submitting any change/);
    assert.match(instructions, /without asking for additional confirmation/);
    assert.match(instructions, /Use the system browser/);
    assert.match(instructions, /Do not use an in-app browser or embedded webview/);
    assert.match(instructions, /Do not visit GitHub or use the GitHub API or CLI/);
    assert.match(instructions, /Every required GitHub owner, repository, workflow, environment/);
    assert.match(instructions, /supplied tag policy value is v\*/);
    assert.match(instructions, /GitHub environment tag: v\*/);
    assert.match(instructions, /read credentials from \/run\/secrets\/pypi\.json/);
    assert.match(instructions, /pause and ask the user to complete every CAPTCHA/i);
    assert.match(instructions, /Reuse an existing PyPI tab in the system browser/);
    assert.match(instructions, /Never delete a PyPI project or package/);
    assert.match(
      instructions,
      /editing or updating a trusted publisher as replacing that publisher/,
    );
    assert.match(instructions, /Remove duplicates so exactly one matching publisher remains/);
    assert.match(
      instructions,
      /## fixture-native\n- Owner: example\n- Repository name: fixture\n- Workflow name: release\.yml\n- Environment name: pypi-fixture-native/,
    );
    assert.doesNotMatch(instructions, /PyPI project:|GitHub repository:|Workflow path:/);
    assert.match(instructions, /Artifacts: platform-specific wheels/);
    assert.match(instructions, /do not require separate PyPI projects or trusted publishers/);
    assert.ok(project.tasks.tryFind("py:sync"));
    assert.ok(project.tasks.tryFind("py:build"));
  });
});

describe("optional Python release stages", () => {
  it("adds Python publication to the unified workflow without Node publication", () => {
    const directOutdir = mkdtempSync(join(tmpdir(), "project-py-direct-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: directOutdir,
        defaultTagMixins: false,
        github: true,
        repository: "https://github.com/example/fixture.git",
        nodeRelease: false,
      });
      new DBXToolsPythonWorkspace(project, {
        root: "python/packages",
        packages: [
          {
            directory: "core",
            description: "Fixture core",
          },
        ],
        release: true,
      });
      project.synth();
      const workflow = readWorkflow(directOutdir);
      assert.deepEqual(workflow.concurrency, {
        group: "release",
        "cancel-in-progress": true,
      });
      assert.ok(workflow.jobs["build-python"]);
      assert.ok(workflow.jobs["publish-pypi-core"]);
      assert.equal(workflow.jobs["publish-node"], undefined);
      assert.equal("repository_dispatch" in workflow.on, false);
      assert.equal("workflow_run" in workflow.on, false);
    } finally {
      rmSync(directOutdir, { recursive: true, force: true });
    }
  });
});
