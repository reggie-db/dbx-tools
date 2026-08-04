/** Reusable uv workspace generation for Python packages hosted in a projen tree. */
import { string } from "@dbx-tools/shared-core";
import { Component, type Project, javascript, python, vscode } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission } from "projen/lib/github/workflows-model";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";

/** Git location used by direct `#subdirectory=` package dependencies. */
export interface PythonRepositoryOptions {
  readonly url: string;
  readonly ref?: string;
  readonly root?: string;
}

/** One independently installable Python package in the uv workspace. */
export interface PythonPackageOptions extends DBXToolsProjectOptions {
  readonly directory: string;
  readonly name: string;
  readonly module: string;
  readonly description: string;
  readonly dependencies?: readonly string[];
}

/** Options for one projen-native Python workspace member. */
export interface DBXToolsPythonProjectOptions extends DBXToolsProjectOptions {
  readonly parent: Project;
  readonly package: PythonPackageOptions;
  readonly repository: Required<PythonRepositoryOptions>;
  readonly requiresPython: string;
}

/** Python release workflow configuration. */
export interface PythonReleaseOptions {
  readonly workflowName?: string;
  /** GitHub environment by Python distribution name. Defaults to `pypi-<name>`. */
  readonly environments?: Readonly<Record<string, string>>;
  readonly environmentUrl?: string;
}

/** Options for {@link DBXToolsPythonWorkspace}. */
export interface DBXToolsPythonWorkspaceOptions {
  readonly packages: readonly PythonPackageOptions[];
  readonly repository: PythonRepositoryOptions;
  readonly requiresPython?: string;
  readonly ruffTarget?: string;
  readonly workspaceName?: string;
  readonly devDependencies?: readonly string[];
  readonly testPaths?: readonly string[];
  readonly lintPaths?: readonly string[];
  readonly ruffPerFileIgnores?: Readonly<Record<string, readonly string[]>>;
  readonly interpreterPath?: string | false;
  readonly release?: boolean | PythonReleaseOptions;
}

const DEFAULT_DEV_DEPENDENCIES = [
  "pytest>=8.4,<9",
  "pytest-asyncio>=1.1,<2",
  "pyyaml>=6.0,<7",
  "ruff>=0.12,<1",
] as const;

const quote = (value: string): string => JSON.stringify(value);

/** Repository-relative path for a Python package directory. */
export function pythonPackagePath(repository: PythonRepositoryOptions, directory: string): string {
  return `${repository.root ?? "packages/py"}/${directory}`;
}

/** PEP 508 dependency pointing at a sibling package in a Git repository. */
export function pythonGitDependency(
  repository: PythonRepositoryOptions,
  name: string,
  directory: string,
): string {
  return `${name} @ git+${repository.url}@${repository.ref ?? "main"}#subdirectory=${pythonPackagePath(repository, directory)}`;
}

function projectVscode(project: Project): vscode.VsCode | undefined {
  return (project as Project & { readonly vscode?: vscode.VsCode }).vscode;
}

/** A Python package implemented with projen's `PythonProject` and uv backend. */
export class DBXToolsPythonProject extends python.PythonProject implements DBXToolsProject {
  readonly language = "python" as const;
  readonly packageOptions: PythonPackageOptions;
  readonly uv: python.Uv;

  constructor(options: DBXToolsPythonProjectOptions) {
    const pkg = options.package;
    super({
      parent: options.parent,
      outdir: pythonPackagePath(options.repository, pkg.directory),
      name: pkg.name,
      moduleName: pkg.module,
      authorName: "",
      authorEmail: "",
      version: "0.0.0",
      description: pkg.description,
      github: false,
      sample: false,
      pytest: false,
      projenrcPython: false,
      projenrcJs: false,
      projenrcTs: false,
      pip: false,
      venv: false,
      setuptools: false,
      poetry: false,
      uv: true,
      projenCommand: options.parent.projenCommand,
      uvOptions: {
        project: {
          name: pkg.name,
          version: "0.0.0",
          description: pkg.description,
          readme: "README.md",
          requiresPython: options.requiresPython,
          dependencies: [...(pkg.dependencies ?? [])],
          urls: {
            Source: `${options.repository.url.replace(/\.git$/, "")}/tree/${options.repository.ref}/${pythonPackagePath(options.repository, pkg.directory)}`,
          },
        },
        buildSystem: {
          requires: ["uv_build>=0.11.28,<0.12.0"],
          buildBackend: "uv_build",
        },
        uv: {
          buildBackend: {
            moduleName: pkg.module,
            moduleRoot: "src",
            namespace: true,
          },
        },
      },
    });
    this.packageOptions = pkg;
    if (!(this.packagingManager instanceof python.Uv)) {
      throw new Error(`Expected uv packaging for ${pkg.name}`);
    }
    this.uv = this.packagingManager;
    this.uv.file.addDeletionOverride("project.authors");
    this.uv.file.addDeletionOverride("dependency-groups");
    this.uv.file.readonly = true;

    for (const path of [".gitattributes", ".gitignore"]) {
      this.tryRemoveFile(path);
    }
  }

  /** The root workspace owns dependency installation for every member. */
  public override postSynthesize(): void {}
}

/**
 * Generates a root uv workspace, projen-native Python member projects, Python
 * tasks, editor interpreter selection, and an optional publishing workflow.
 */
export class DBXToolsPythonWorkspace extends Component {
  readonly packages: readonly DBXToolsPythonProject[];
  readonly repository: Required<PythonRepositoryOptions>;
  readonly requiresPython: string;
  readonly file: python.PyprojectTomlFile;

  constructor(project: javascript.NodeProject, options: DBXToolsPythonWorkspaceOptions) {
    super(project);
    this.repository = {
      url: options.repository.url,
      ref: options.repository.ref ?? "main",
      root: options.repository.root ?? "packages/py",
    };
    this.requiresPython = options.requiresPython ?? ">=3.10";
    this.file = this.emitWorkspace(project, options);
    this.packages = options.packages.map(
      (pkg) =>
        new DBXToolsPythonProject({
          parent: project,
          package: pkg,
          repository: this.repository,
          requiresPython: this.requiresPython,
        }),
    );
    for (const pkg of this.packages) {
      const pyproject = `/${pythonPackagePath(this.repository, pkg.packageOptions.directory)}/pyproject.toml`;
      project.gitignore.include(pyproject);
      project.gitattributes.addAttributes(pyproject, "linguist-generated");
      project.prettier?.addIgnorePattern(pyproject.slice(1));
    }
    this.addTasks(project, options);

    const interpreterPath = options.interpreterPath ?? "${workspaceFolder}/.venv/bin/python";
    if (interpreterPath !== false) {
      projectVscode(project)?.settings.addSetting("python.defaultInterpreterPath", interpreterPath);
    }

    if (options.release) {
      this.addReleaseWorkflow(project, options.release === true ? {} : options.release);
    }
  }

  /** Repository-relative package directory. */
  packagePath(directory: string): string {
    return pythonPackagePath(this.repository, directory);
  }

  /** PEP 508 dependency pointing at a sibling package in the configured repository. */
  gitDependency(name: string, directory: string): string {
    return pythonGitDependency(this.repository, name, directory);
  }

  private emitWorkspace(
    project: javascript.NodeProject,
    options: DBXToolsPythonWorkspaceOptions,
  ): python.PyprojectTomlFile {
    const testPaths = options.testPaths ?? [this.repository.root];
    const perFileIgnores = options.ruffPerFileIgnores ?? {};
    const file = new python.PyprojectTomlFile(project, {
      project: {
        name: options.workspaceName ?? `${string.toSlug(project.name)}-python-workspace`,
        version: "0.0.0",
        requiresPython: this.requiresPython,
        dependencies: [],
      },
      dependencyGroups: {
        dev: [...(options.devDependencies ?? DEFAULT_DEV_DEPENDENCIES)],
      },
      tool: {
        uv: python.uvConfig.toJson_UvConfiguration({
          package: false,
          workspace: { members: [`${this.repository.root}/*`] },
        }),
        pytest: {
          ini_options: {
            asyncio_mode: "auto",
            testpaths: testPaths,
          },
        },
        ruff: {
          "target-version": options.ruffTarget ?? "py310",
          "line-length": 100,
          lint: {
            "per-file-ignores": perFileIgnores,
          },
        },
      },
    });
    file.addOverride(
      "tool.uv.sources",
      Object.fromEntries(options.packages.map((pkg) => [pkg.name, { workspace: true }])),
    );
    file.readonly = true;
    return file;
  }

  private addTasks(project: javascript.NodeProject, options: DBXToolsPythonWorkspaceOptions): void {
    const lintPaths = options.lintPaths ?? [this.repository.root];
    project.addTask("py:sync", {
      exec: "uv sync --all-packages",
      description: "Resolve and install every Python workspace package",
    });
    project.addTask("py:test", {
      exec: "uv run pytest",
      description: "Run Python workspace tests",
    });
    project.addTask("py:lint", {
      exec: `uv run ruff check ${lintPaths.join(" ")}`,
      description: "Lint Python workspace packages",
    });
    project.addTask("py:format", {
      exec: `uv run ruff format ${lintPaths.join(" ")}`,
      description: "Format Python workspace packages",
    });
    project.addTask("py:build", {
      exec: "uv build --all-packages",
      description: "Build every Python workspace package",
    });
  }

  private addReleaseWorkflow(project: javascript.NodeProject, options: PythonReleaseOptions): void {
    if (!project.github) return;
    const workflow = new GithubWorkflow(project.github, options.workflowName ?? "python-release");
    workflow.file?.addOverride("permissions", { contents: "read" });
    workflow.on({ push: { tags: ["v*"] }, workflowDispatch: {} });
    workflow.file?.addOverride("on.workflow_dispatch", {
      inputs: {
        version: {
          description: "Python package version to build",
          type: "string",
          required: true,
        },
      },
    });
    workflow.addJob("build", {
      runsOn: ["ubuntu-latest"],
      permissions: { contents: JobPermission.READ },
      timeoutMinutes: 20,
      steps: [
        { name: "Checkout", uses: "actions/checkout@v6" },
        { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
        {
          name: "Stamp workspace versions",
          env: {
            VERSION: "${{ github.event_name == 'push' && github.ref_name || inputs.version }}",
          },
          run: this.renderVersionStampScript(),
        },
        {
          name: "Build distributions",
          run: this.packages
            .map(
              (pkg) =>
                `uv build --package ${pkg.packageOptions.name} --out-dir dist/${pkg.packageOptions.directory}`,
            )
            .join("\n"),
        },
        {
          name: "Validate distributions",
          run: [
            `test "$(find dist -type f \\( -name '*.whl' -o -name '*.tar.gz' \\) | wc -l | tr -d ' ')" -eq ${this.packages.length * 2}`,
            "uvx twine check dist/*/*.whl dist/*/*.tar.gz",
          ].join("\n"),
        },
        {
          name: "Upload distributions",
          uses: "actions/upload-artifact@v7",
          with: { name: "python-distributions", path: "dist" },
        },
      ],
    });
    for (const pkg of this.packages) {
      workflow.addJob(`publish-${pkg.packageOptions.directory}`, {
        if: "${{ github.event_name == 'push' }}",
        needs: ["build"],
        environment: {
          name:
            options.environments?.[pkg.packageOptions.name] ?? `pypi-${pkg.packageOptions.name}`,
          url:
            options.environmentUrl ??
            `https://pypi.org/project/${pkg.packageOptions.name.replaceAll("_", "-")}/`,
        },
        runsOn: ["ubuntu-latest"],
        permissions: { idToken: JobPermission.WRITE },
        timeoutMinutes: 10,
        steps: [
          {
            name: "Download distributions",
            uses: "actions/download-artifact@v8",
            with: { name: "python-distributions", path: "dist" },
          },
          {
            name: `Publish ${pkg.packageOptions.name} to PyPI`,
            uses: "pypa/gh-action-pypi-publish@release/v1",
            with: { "packages-dir": `dist/${pkg.packageOptions.directory}` },
          },
        ],
      });
    }
  }

  private renderVersionStampScript(): string {
    return [
      `chmod -R u+w ${this.repository.root}`,
      "python - <<'PY'",
      "from pathlib import Path",
      "import os",
      "import re",
      "",
      'version = os.environ["VERSION"].removeprefix("v")',
      `package_files = sorted(Path(${quote(this.repository.root)}).glob("*/pyproject.toml"))`,
      "packages = {}",
      "for path in package_files:",
      '    source = path.read_text(encoding="utf-8")',
      '    name = re.search(r\'^name = "([^"]+)"$\', source, re.MULTILINE)',
      "    if name is None:",
      '        raise ValueError(f"Missing project name in {path}")',
      "    packages[name.group(1)] = path.parent.name",
      "",
      "for path in package_files:",
      '    source = path.read_text(encoding="utf-8")',
      "    source, count = re.subn(",
      '        r\'^version = "[^"]+"$\',',
      "        f'version = \"{version}\"',",
      "        source,",
      "        count=1,",
      "        flags=re.MULTILINE,",
      "    )",
      "    if count != 1:",
      '        raise ValueError(f"Expected one project version in {path}")',
      "    for name, directory in packages.items():",
      "        source = re.sub(",
      `            rf'{re.escape(name)} @ git\\+[^" ]+#subdirectory=${this.repository.root}/{re.escape(directory)}',`,
      '            f"{name}=={version}",',
      "            source,",
      "        )",
      '    path.write_text(source, encoding="utf-8")',
      "PY",
    ].join("\n");
  }
}
