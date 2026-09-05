import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsPythonWorkspace } from "../src/project.ts";

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
        {
          directory: "native",
          description: "Native binding package",
          uniffi: true,
          generatedSources: ["src/fixture/native/bindings.py"],
          trustedPublisher: {
            workflowName: "rust-release",
            environment: "pypi-fixture-native",
            artifacts: "platform-specific wheels for all supported architectures",
          },
        },
      ],
      dependencies: ["fixture-app"],
      requiresPython: ">=3.12",
      indexStrategy: "unsafe-best-match",
      ruffTarget: "py312",
      lintPaths: ["python"],
      interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
      release: {
        workflowName: "publish-python",
        upstreamWorkflow: "rust-release",
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
    const release = readFileSync(join(outdir, ".github/workflows/publish-python.yml"), "utf8");
    assert.match(release, /workflows:\s+- rust-release/);
    assert.match(release, /steps\.release_metadata\.outputs\.release_tag \|\| inputs\.version/);
    assert.match(release, /version = os\.environ\["VERSION"\]\.removeprefix\("v"\)/);
    assert.match(release, /^  publish-core:$/m);
    assert.match(release, /^  publish-standard:$/m);
    assert.match(release, /^      name: pypi-fixture-core$/m);
    assert.match(release, /^          packages-dir: dist\/core$/m);
    assert.match(release, /^  publish-app:$/m);
    assert.match(release, /name: Download release metadata/);
    assert.match(release, /steps\.release_metadata\.outputs\.expected_sha/);
    assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
    assert.match(release, /^      name: production-pypi$/m);
    assert.match(release, /^          packages-dir: dist\/app$/m);
    assert.match(release, /github\.event_name == 'workflow_run'/);
    assert.doesNotMatch(release, /inputs\.publish/);
    assert.doesNotMatch(release, /^  publish:$/m);
    assert.match(release, /^  publish-native:$/m);
    assert.match(release, /pattern: fixture-native--\*--python-wheel/);
    assert.match(
      release,
      /run-id: \$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.rust_run_id \|\| github\.event\.workflow_run\.id \}\}/,
    );
    const nodeRelease = readFileSync(join(outdir, ".github/workflows/node-release.yml"), "utf8");
    assert.match(nodeRelease, /^  repository_dispatch:\n    types:\n      - release$/m);
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
      /## fixture-core\n- Owner: example\n- Repository name: fixture\n- Workflow name: publish-python\.yml\n- Environment name: pypi-fixture-core/,
    );
    assert.match(
      instructions,
      /## fixture-app\n- Owner: example\n- Repository name: fixture\n- Workflow name: publish-python\.yml\n- Environment name: production-pypi/,
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
    assert.match(instructions, /supplied branch policy value is main/);
    assert.doesNotMatch(instructions, /permit deployments from the main branch/);
    assert.match(instructions, /GitHub environment branch: main/);
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
      /## fixture-native\n- Owner: example\n- Repository name: fixture\n- Workflow name: rust-release\.yml\n- Environment name: pypi-fixture-native/,
    );
    assert.doesNotMatch(instructions, /PyPI project:|GitHub repository:|Workflow path:/);
    assert.match(instructions, /Artifacts: platform-specific wheels/);
    assert.match(instructions, /do not require separate PyPI projects or trusted publishers/);
    assert.ok(project.tasks.tryFind("py:sync"));
    assert.ok(project.tasks.tryFind("py:build"));
  });
});

describe("optional Python release stages", () => {
  it("publishes from the downstream release event", () => {
    const directOutdir = mkdtempSync(join(tmpdir(), "project-py-direct-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: directOutdir,
        defaultTagMixins: false,
        github: true,
        repository: "https://github.com/example/fixture.git",
        nodeReleaseWorkflowName: false,
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
      const workflow = readFileSync(
        join(directOutdir, ".github", "workflows", "python-release.yml"),
        "utf8",
      );
      assert.match(workflow, /^  repository_dispatch:\n    types:\n      - release$/m);
      assert.match(workflow, /^  cancel-in-progress: true$/m);
      assert.doesNotMatch(workflow, /workflow_run:/);
      assert.match(workflow, /name: Upload release metadata/);
      assert.match(
        readFileSync(join(directOutdir, ".github", "workflows", "release-dispatch.yml"), "utf8"),
        /RELEASE_WORKFLOWS: python-release/,
      );
    } finally {
      rmSync(directOutdir, { recursive: true, force: true });
    }
  });
});
