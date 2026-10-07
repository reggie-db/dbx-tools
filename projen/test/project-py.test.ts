import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "smol-toml";
import { readWorkflow, workflowStep } from "./workflow.ts";
import { DBXToolsNodeProject, DBXToolsPythonWorkspace } from "../src/project.ts";
import { generatePythonNodeBindings } from "../src/python-node-bindings.ts";
import { PYTHON_NODE_RUNTIME_DISTRIBUTION } from "../src/python-node-runtime.ts";
import { DEFAULT_VERSION } from "../src/workspace-version.ts";

let outdir: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "project-py-"));
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("DBXToolsPythonWorkspace", () => {
  it("requires an explicitly marked canonical shared Node runtime", () => {
    const validationOutdir = mkdtempSync(join(tmpdir(), "project-py-runtime-validation-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: validationOutdir,
        defaultTagMixins: false,
        repository: "https://github.com/example/fixture.git",
      });
      assert.throws(
        () =>
          new DBXToolsPythonWorkspace(project, {
            packages: [
              {
                directory: "runtime",
                description: "Invalid runtime owner",
                nodeRuntime: true,
              },
            ],
          }),
        /must use distribution dbx-tools-node-runtime and module dbx_tools\.node_runtime/,
      );
    } finally {
      rmSync(validationOutdir, { recursive: true, force: true });
    }
  });

  it("allows only one shared Node runtime owner", () => {
    const validationOutdir = mkdtempSync(join(tmpdir(), "project-py-runtime-count-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: validationOutdir,
        defaultTagMixins: false,
        repository: "https://github.com/example/fixture.git",
      });
      assert.throws(
        () =>
          new DBXToolsPythonWorkspace(project, {
            packages: [
              { directory: "runtime-one", description: "One", nodeRuntime: true },
              { directory: "runtime-two", description: "Two", nodeRuntime: true },
            ],
          }),
        /only one shared Node runtime package/,
      );
    } finally {
      rmSync(validationOutdir, { recursive: true, force: true });
    }
  });

  it("reuses project.vscode and emits a configurable uv workspace", () => {
    const project = new DBXToolsNodeProject({
      name: "fixture",
      outdir,
      defaultTagMixins: false,
      github: true,
      repository: "https://github.com/example/fixture.git",
      releaseDocs: {
        siteUrl: "https://docs.example.com",
        prepareSteps: [],
        buildSteps: [],
        artifactPath: "site/dist",
      },
    });
    assert.ok(project.vscode);

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
          devDependencies: ["types-app>=1"],
          optionalDependencies: {
            dev: ["embedded-postgres>=18,<19"],
          },
          internalDependencies: ["core"],
          releaseEnvironment: "production-pypi",
        },
      ],
      dependencies: ["fixture-app"],
      requiresPython: ">=3.12",
      indexStrategy: "unsafe-best-match",
      ruffTarget: "py312",
      workflowPythonVersion: "3.13",
      devDependencies: ["types-requests>=2"],
      ruffExcludes: ["python/packages/app/src/fixture/app/_upstream"],
      lintPaths: ["python"],
      interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
      release: true,
    });

    project.synth();

    const workspace = readFileSync(join(outdir, "pyproject.toml"), "utf8");
    const workspaceMetadata = parse(workspace) as {
      project: { dependencies: string[]; "requires-python": string };
      tool: {
        ruff: { exclude: string[] };
        uv: {
          "index-strategy": string;
          sources: Record<string, { workspace: boolean }>;
          workspace: { members: string[] };
        };
      };
    };
    assert.deepEqual(workspaceMetadata.tool.uv.workspace.members, ["python/packages/*"]);
    assert.match(workspace, /dependencies = \[\s*"fixture-app"\s*\]/);
    assert.match(workspace, /requires-python = ">=3\.12"/);
    assert.match(workspace, /index-strategy = "unsafe-best-match"/);
    assert.match(workspace, /target[_-]version = "py312"/);
    assert.match(workspace, /"types-requests>=2"/);
    assert.deepEqual(workspaceMetadata.tool.ruff.exclude, [
      "python/packages/app/src/fixture/app/_upstream",
    ]);
    assert.doesNotMatch(workspace, /\[tool\.pyrefly\]/);
    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.venv\/$/m);
    assert.match(gitignore, /^python\/packages\/\*\*\/dist\/$/m);

    const app = readFileSync(join(outdir, "python/packages/app/pyproject.toml"), "utf8");
    assert.match(app, /license = "Apache-2\.0"/);
    assert.match(app, /license-files = \[\s*"LICENSE"\s*\]/);
    assert.match(
      readFileSync(join(outdir, "python/packages/app/LICENSE"), "utf8"),
      /Apache License/,
    );
    assert.match(app, /dependencies = \[\s*"fixture-core"\s*\]/);
    assert.match(app, /\[project\.optional-dependencies\]/);
    assert.match(app, /embedded-postgres>=18,<19/);
    assert.match(app, /\[dependency-groups\]/);
    assert.match(app, /"types-app>=1"/);
    assert.doesNotMatch(
      readFileSync(join(outdir, "python/packages/core/pyproject.toml"), "utf8"),
      /\[dependency-groups\]/,
    );

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
    const validation = readWorkflow(outdir, "build");
    assert.match(workflowStep(validation.jobs.build!, "Setup Python").uses ?? "", /setup-python@/);
    assert.equal(workflowStep(validation.jobs.build!, "Setup uv").uses, "astral-sh/setup-uv@v7");
    const release = readWorkflow(outdir);
    assert.equal(release.jobs["build-python"], undefined);
    const publishCore = release.jobs["publish-pypi-core"]!;
    assert.equal(publishCore.needs, "build-release");
    assert.equal(publishCore.env?.BUN_VERSION, undefined);
    const build = release.jobs["build-release"]!;
    assert.match(workflowStep(build, "Setup Python").uses ?? "", /^actions\/setup-python@/);
    assert.deepEqual(workflowStep(build, "Setup Python").with, { "python-version": "3.13" });
    assert.equal(workflowStep(build, "Setup uv").uses, "astral-sh/setup-uv@v7");
    assert.equal(workflowStep(build, "Setup uv").with, undefined);
    assert.ok(
      workflowStep(build, "Build Python distributions").run?.includes("--package-directories"),
    );
    assert.ok(
      workflowStep(build, "Build Python distributions").run?.includes('--package "core" "app"'),
    );
    assert.deepEqual(workflowStep(publishCore, "Download fixture-core distributions").with, {
      name: "release-python-core",
      path: "dist/core",
    });
    for (const job of Object.values(release.jobs)) {
      if (!job.environment || job.environment.name === "github-pages") continue;
      assert.equal(job.steps.length, 2);
      assert.match(job.steps[0]?.uses ?? "", /^actions\/download-artifact@/);
      assert.equal(job.steps[1]?.uses, "pypa/gh-action-pypi-publish@release/v1");
    }
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
    assert.deepEqual(release.jobs["publish-pypi-app"]?.environment, {
      name: "production-pypi",
      url: "https://pypi.org/project/fixture-app/",
    });
    assert.deepEqual(release.jobs["publish-pypi-app"]?.needs, [
      "build-release",
      "publish-pypi-core",
    ]);
    assert.equal(release.jobs["build-docs"], undefined);
    assert.deepEqual(release.jobs["deploy-docs"]?.needs, [
      "build-release",
      "publish-node",
      "publish-pypi-core",
      "publish-pypi-app",
    ]);
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);
    const instructionsTask = project.tasks.tryFind("pypiTrustedPublisherInstructions");
    const instructionsCommand = instructionsTask?.steps?.[0]?.exec;
    assert.equal(instructionsCommand, "bun .projen/pypi-trusted-publisher-instructions.mjs");
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
    assert.match(instructions, /supplied deployment tag policy value is v\*/);
    assert.doesNotMatch(instructions, /GitHub environment tag:/);
    assert.match(instructions, /read credentials from \/run\/secrets\/pypi\.json/);
    assert.match(instructions, /pause and ask the user to complete every CAPTCHA/i);
    assert.match(instructions, /Reuse an existing PyPI tab in the system browser/);
    assert.match(instructions, /Never delete a PyPI project or package/);
    assert.match(
      instructions,
      /editing or updating a trusted publisher as replacing that publisher/,
    );
    assert.match(instructions, /Remove duplicates so exactly one matching publisher remains/);
    assert.doesNotMatch(instructions, /PyPI project:|GitHub repository:|Workflow path:/);
    assert.ok(project.tasks.tryFind("py:sync"));
    assert.ok(project.tasks.tryFind("py:build"));
  });

  it("discovers pyproject-driven Node bindings during root synthesis", () => {
    const bindingsOutdir = mkdtempSync(join(tmpdir(), "project-py-node-bindings-"));
    try {
      mkdirSync(join(bindingsOutdir, "packages/js/node/auth/src"), { recursive: true });
      writeFileSync(
        join(bindingsOutdir, "packages/js/node/auth/src/auth.ts"),
        "export function authenticate(): void {}\n",
      );
      for (const [name, module, source] of [
        ["auth", "client", "export function authenticate(): void {}\n"],
        ["core", "config", "export function configure(): void {}\n"],
      ]) {
        const directory = join(bindingsOutdir, "node_modules/@fixture", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({ name: `@fixture/${name}`, type: "module", exports: "./index.ts" }),
        );
        writeFileSync(
          join(directory, "index.ts"),
          `export * as ${module} from "./${module}.ts";\n`,
        );
        writeFileSync(join(directory, `${module}.ts`), source);
      }
      const project = new DBXToolsNodeProject({
        name: "fixture",
        outdir: bindingsOutdir,
        defaultTagMixins: false,
        packageRoots: ["packages/js"],
        repository: "https://github.com/example/fixture.git",
      });
      const pythonWorkspace = new DBXToolsPythonWorkspace(project, {
        root: "python/packages",
        packages: [
          {
            directory: "node-runtime",
            name: PYTHON_NODE_RUNTIME_DISTRIBUTION,
            module: "dbx_tools.node_runtime",
            description: "Fixture shared Node runtime",
            nodeRuntime: true,
          },
          {
            directory: "auth",
            description: "Fixture auth bindings",
            nodeBindings: [
              {
                package: "@fixture/auth",
                functionOverrides: [
                  {
                    module: "@fixture/core/file-lock",
                    export: "acquireFileLock",
                    handler: "projen/test/fixtures/python-node-function-override.ts",
                  },
                ],
              },
              {
                package: "@fixture/core",
                modules: ["config"],
              },
            ],
          },
        ],
      });
      const authPackage = pythonWorkspace.packages.find(
        ({ packageOptions }) => packageOptions.directory === "auth",
      );
      assert.deepEqual(authPackage?.packageOptions.internalDependencies, ["node-runtime"]);

      project.synth();
      generatePythonNodeBindings(bindingsOutdir);

      const packagePyproject = join(bindingsOutdir, "python/packages/auth/pyproject.toml");
      const pyproject = parse(readFileSync(packagePyproject, "utf8")) as {
        project: { dependencies: string[] };
        tool: {
          dbx_tools: {
            node_bindings: Array<{
              package: string;
              modules?: string[];
              function_overrides?: Array<Record<string, string>>;
            }>;
          };
          uv: { "build-backend": { "module-root": string } };
        };
      };
      assert.ok(
        pyproject.project.dependencies.includes(
          `${PYTHON_NODE_RUNTIME_DISTRIBUTION}==${DEFAULT_VERSION}`,
        ),
      );
      assert.deepEqual(pyproject.tool.dbx_tools.node_bindings, [
        {
          package: "@fixture/auth",
          function_overrides: [
            {
              module: "@fixture/core/file-lock",
              export: "acquireFileLock",
              handler: "projen/test/fixtures/python-node-function-override.ts",
            },
          ],
        },
        {
          package: "@fixture/core",
          modules: ["config"],
        },
      ]);
      assert.equal(pyproject.tool.uv["build-backend"]["module-root"], "src");
      const workspacePyproject = parse(
        readFileSync(join(bindingsOutdir, "pyproject.toml"), "utf8"),
      ) as {
        tool: { ruff: { exclude: string[] } };
      };
      assert.deepEqual(workspacePyproject.tool.ruff.exclude, [
        "python/packages/auth/src/fixture/auth/_generated/**",
      ]);
      assert.equal(
        existsSync(
          join(
            bindingsOutdir,
            "python/packages/auth/src/fixture/auth/_generated/node/auth/client.py",
          ),
        ),
        true,
      );
      assert.equal(
        statSync(
          join(
            bindingsOutdir,
            "python/packages/auth/src/fixture/auth/_generated/node/auth/client.py",
          ),
        ).mode & 0o222,
        0,
      );
      assert.equal(
        statSync(
          join(bindingsOutdir, "python/packages/auth/src/fixture/auth/_generated/node/_runtime.js"),
        ).mode & 0o222,
        0,
      );
      const runtimeLoader = readFileSync(
        join(bindingsOutdir, "python/packages/auth/src/fixture/auth/_generated/node/_runtime.py"),
        "utf8",
      );
      assert.match(
        runtimeLoader,
        /from dbx_tools\.node_runtime import MISSING, RuntimeBundle, load_bundle/,
      );
      assert.doesNotMatch(runtimeLoader, /pythonmonkey|class _NodeObject/);
      assert.equal(
        existsSync(
          join(
            bindingsOutdir,
            "python/packages/auth/src/fixture/auth/_generated/node/core/config.py",
          ),
        ),
        true,
      );
      assert.ok(project.tasks.tryFind("python-node-bindings"));
      assert.ok(project.tasks.tryFind("python-node-bindings:check"));
      assert.ok(project.tasks.tryFind("python-node-bindings:watch"));
      assert.ok(project.tasks.tryFind("python-node-runtime"));
      assert.ok(project.tasks.tryFind("python-node-runtime:check"));
      assert.ok(project.tasks.tryFind("python-node-runtime:watch"));
      assert.deepEqual(project.dbxToolsConfig.syncWatchTasks, [
        "python-node-runtime:watch",
        "python-node-bindings:watch",
      ]);
      rmSync(packagePyproject);
      generatePythonNodeBindings(bindingsOutdir);
      assert.equal(
        existsSync(join(bindingsOutdir, "python/packages/auth/src/fixture/auth/_generated/node")),
        false,
      );
    } finally {
      rmSync(bindingsOutdir, { recursive: true, force: true });
    }
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
        group: "release-${{ github.ref_name }}",
        "cancel-in-progress": false,
      });
      assert.equal(workflow.jobs["build-python"], undefined);
      assert.ok(workflow.jobs["publish-pypi-core"]);
      assert.equal(workflow.jobs["publish-node"], undefined);
      assert.equal("repository_dispatch" in workflow.on, false);
      assert.equal("workflow_run" in workflow.on, false);
    } finally {
      rmSync(directOutdir, { recursive: true, force: true });
    }
  });
});
