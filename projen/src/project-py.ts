/** Reusable uv workspace generation for Python packages hosted in a projen tree. */
import { string } from "@dbx-tools/shared-core";
import { Component, TextFile, type Project, javascript, python, vscode } from "projen";
import type { IResolver } from "projen/lib/file";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission } from "projen/lib/github/workflows-model";
import { parse, stringify } from "smol-toml";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

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
  readonly scripts?: Readonly<Record<string, string>>;
  /** Keep this package unpublished and out of public docs and releases. */
  readonly private?: boolean;
}

/** Options for one projen-native Python workspace member. */
export interface DBXToolsPythonProjectOptions extends DBXToolsProjectOptions {
  readonly parent: Project;
  readonly package: PythonPackageOptions;
  readonly repository: Required<PythonRepositoryOptions>;
  readonly requiresPython: string;
  /** Workspace version copied onto this package's `pyproject.toml`. */
  readonly version: string;
}

/** Python release workflow configuration. */
export interface PythonReleaseOptions {
  readonly workflowName?: string;
  /** GitHub environment by Python distribution name. Defaults to `pypi-<name>`. */
  readonly environments?: Readonly<Record<string, string>>;
  readonly environmentUrl?: string;
}

interface PythonPublication {
  readonly directory: string;
  readonly distribution: string;
  readonly environment: string;
}

/** Options for {@link DBXToolsPythonWorkspace}. */
export interface DBXToolsPythonWorkspaceOptions {
  readonly packages: readonly PythonPackageOptions[];
  readonly repository: PythonRepositoryOptions;
  /** Workspace packages exposed as commands from the repository root. */
  readonly dependencies?: readonly string[];
  readonly requiresPython?: string;
  /** uv strategy for repositories that intentionally use multiple trusted indexes. */
  readonly indexStrategy?: "first-index" | "unsafe-first-match" | "unsafe-best-match";
  readonly ruffTarget?: string;
  readonly workspaceName?: string;
  readonly devDependencies?: readonly string[];
  readonly testPaths?: readonly string[];
  readonly lintPaths?: readonly string[];
  readonly ruffPerFileIgnores?: Readonly<Record<string, readonly string[]>>;
  /** Generated Python implementation files Pyrefly should resolve but not type-check. */
  readonly pyreflyProjectExcludes?: readonly string[];
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

interface TomlSynthesizer {
  synthesizeContent(resolver: IResolver): string | undefined;
}

function formatPyproject(file: python.PyprojectTomlFile): void {
  const target = file as unknown as TomlSynthesizer;
  const synthesize = target.synthesizeContent.bind(file);
  target.synthesizeContent = (resolver) => {
    const content = synthesize(resolver);
    if (!content) return content;
    const marker = content.startsWith("# ") ? content.slice(0, content.indexOf("\n")) : undefined;
    const body = stringify(parse(content))
      .trimEnd()
      .replace(/ = \[ (.*) \]$/gm, " = [$1]");
    return `${marker ? `${marker}\n\n` : ""}${body}\n`;
  };
}

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
      version: options.version,
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
          version: options.version,
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
    if (pkg.scripts) {
      this.uv.file.addOverride("project.scripts", pkg.scripts);
    }
    if (pkg.private) {
      this.uv.file.addOverride("tool.dbx-tools.private", true);
    }
    formatPyproject(this.uv.file);
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
  readonly version: string;
  readonly file: python.PyprojectTomlFile;

  constructor(project: javascript.NodeProject, options: DBXToolsPythonWorkspaceOptions) {
    super(project);
    this.repository = {
      url: options.repository.url,
      ref: options.repository.ref ?? "main",
      root: options.repository.root ?? "packages/py",
    };
    this.requiresPython = options.requiresPython ?? ">=3.10";
    // The single workspace version, copied from the root `VERSION` file so Python
    // members carry the same number as their JS siblings.
    this.version = readWorkspaceVersion(project.outdir);
    this.file = this.emitWorkspace(project, options);
    this.packages = options.packages.map(
      (pkg) =>
        new DBXToolsPythonProject({
          parent: project,
          package: pkg,
          repository: this.repository,
          requiresPython: this.requiresPython,
          version: this.version,
        }),
    );
    for (const pkg of this.packages) {
      const pyproject = `/${pythonPackagePath(this.repository, pkg.packageOptions.directory)}/pyproject.toml`;
      project.gitignore.include(pyproject);
      project.gitattributes.addAttributes(pyproject, "linguist-generated");
      project.prettier?.addIgnorePattern(pyproject.slice(1));
    }
    this.addTasks(project, options);

    const releaseOptions = options.release === true ? {} : options.release || {};
    this.addTrustedPublisherInstructionsTask(project, releaseOptions);

    const interpreterPath = options.interpreterPath ?? "${workspaceFolder}/.venv/bin/python";
    if (interpreterPath !== false) {
      projectVscode(project)?.settings.addSetting("python.defaultInterpreterPath", interpreterPath);
    }

    if (options.release) {
      this.addReleaseWorkflow(project, releaseOptions);
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
        version: this.version,
        requiresPython: this.requiresPython,
        dependencies: [...(options.dependencies ?? [])],
      },
      dependencyGroups: {
        dev: [...(options.devDependencies ?? DEFAULT_DEV_DEPENDENCIES)],
      },
      tool: {
        uv: python.uvConfig.toJson_UvConfiguration({
          package: false,
          workspace: {
            members: [`${this.repository.root}/*`],
          },
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
    if (options.indexStrategy) {
      file.addOverride("tool.uv.index-strategy", options.indexStrategy);
    }
    file.addOverride("tool.pyrefly.ignore-errors-in-generated-code", true);
    if (options.pyreflyProjectExcludes?.length) {
      file.addOverride("tool.pyrefly.project-excludes", [...options.pyreflyProjectExcludes]);
    }
    file.addOverride(
      "tool.uv.sources",
      Object.fromEntries(options.packages.map((pkg) => [pkg.name, { workspace: true }])),
    );
    formatPyproject(file);
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
    const publications = this.publications(options);
    if (publications.length === 0) return;
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
          run: publications
            .map(
              (publication) =>
                `uv build --package ${publication.distribution} --out-dir dist/${publication.directory}`,
            )
            .join("\n"),
        },
        {
          name: "Validate distributions",
          run: [
            `test "$(find dist -type f \\( -name '*.whl' -o -name '*.tar.gz' \\) | wc -l | tr -d ' ')" -eq ${publications.length * 2}`,
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
    for (const publication of publications) {
      workflow.addJob(`publish-${publication.directory}`, {
        if: "${{ github.event_name == 'push' }}",
        needs: ["build"],
        environment: {
          name: publication.environment,
          url:
            options.environmentUrl ??
            `https://pypi.org/project/${publication.distribution.replaceAll("_", "-")}/`,
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
            name: `Publish ${publication.distribution} to PyPI`,
            uses: "pypa/gh-action-pypi-publish@release/v1",
            with: { "packages-dir": `dist/${publication.directory}` },
          },
        ],
      });
    }
  }

  private publications(options: PythonReleaseOptions): readonly PythonPublication[] {
    return this.packages
      .filter((pkg) => !pkg.packageOptions.private)
      .map((pkg) => ({
        directory: pkg.packageOptions.directory,
        distribution: pkg.packageOptions.name,
        environment:
          options.environments?.[pkg.packageOptions.name] ?? `pypi-${pkg.packageOptions.name}`,
      }));
  }

  private addTrustedPublisherInstructionsTask(
    project: javascript.NodeProject,
    options: PythonReleaseOptions,
  ): void {
    const workflowName = `${options.workflowName ?? "python-release"}.yml`;
    const workflowPath = `.github/workflows/${workflowName}`;
    const repository = this.githubRepository();
    const publications = this.publications(options);
    const linesBeforeAuthentication = [
      "# PyPI Trusted Publisher Setup Instructions",
      "",
      "Use a browser to configure the following PyPI trusted publishers.",
      "For each project, inspect any existing GitHub publisher and ensure every field is synchronized to the desired values below. Update a mismatched publisher when PyPI permits it; otherwise remove the mismatched publisher and create the correct one. Create the publisher when it does not exist. Do not create duplicates.",
      "",
      "Authentication rules:",
    ];
    const linesAfterAuthentication = [
      "- Pause and ask the user to complete every CAPTCHA. Do not attempt to solve or bypass a CAPTCHA.",
      "- After the user completes an authentication or CAPTCHA step, continue from the current browser session.",
      "",
      "Publisher type: GitHub Actions",
      "Pending publisher: use only when the PyPI project does not exist yet",
      "",
      ...publications.flatMap((publication) => [
        `## ${publication.distribution}`,
        `- PyPI project: ${publication.distribution}`,
        `- GitHub repository: ${repository.owner}/${repository.name}`,
        `- Repository owner: ${repository.owner}`,
        `- Repository name: ${repository.name}`,
        `- GitHub environment: ${publication.environment}`,
        `- Workflow filename: ${workflowName}`,
        `- Workflow path: ${workflowPath}`,
        "",
      ]),
    ];
    const helper = ".projen/pypi-trusted-publisher-instructions.mjs";
    new TextFile(project.root, helper, {
      lines: [
        "#!/usr/bin/env node",
        'import { parseArgs } from "node:util";',
        "",
        "const { values } = parseArgs({",
        '  options: { secretFile: { type: "string" } },',
        "});",
        `const beforeAuthentication = ${JSON.stringify(linesBeforeAuthentication)};`,
        `const afterAuthentication = ${JSON.stringify(linesAfterAuthentication)};`,
        "const authentication = values.secretFile",
        "  ? [",
        "      `- If browser authentication is required, read credentials from ${values.secretFile} directly into the browser without printing, logging, or exposing secret values.`,",
        "      `- If ${values.secretFile} is absent, invalid, or insufficient for authentication, pause and ask the user to complete authentication.`,",
        "    ]",
        '  : ["- If browser authentication is required, pause and ask the user to complete authentication."];',
        'process.stdout.write(`${[...beforeAuthentication, ...authentication, ...afterAuthentication].join("\\n").trimEnd()}\\n`);',
      ],
    });
    project.root.addTask("pypiTrustedPublisherInstructions", {
      description: "Print browser-agent instructions for PyPI trusted publishers",
      exec: `node ${helper}`,
      receiveArgs: true,
    });
  }

  private githubRepository(): { readonly owner: string; readonly name: string } {
    const match = this.repository.url
      .replace(/\.git$/, "")
      .match(/github\.com(?:[/:])([^/]+)\/([^/]+)$/);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Python repository must be hosted on GitHub: ${this.repository.url}`);
    }
    return { owner: match[1], name: match[2] };
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
