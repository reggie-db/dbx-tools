/** Reusable uv workspace generation for Python packages hosted in a projen tree. */
import { project as coreProject } from "@dbx-tools/core";
import { string } from "@dbx-tools/shared-core";
import { Component, TextFile, type Project, javascript, python, vscode } from "projen";
import type { IResolver } from "projen/lib/file";
import { JobPermission } from "projen/lib/github/workflows-model";
import { parse, stringify } from "smol-toml";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import { projectRepositoryUrl } from "./project-js.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";
import { RELEASE_VERSION, releaseSourceSteps } from "./release-dispatch.ts";
import {
  releaseArtifactSteps,
  releasePublishCondition,
  releaseStageCondition,
  releaseTagPattern,
  releaseWorkflow,
} from "./release.ts";
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
  readonly name?: string;
  readonly module?: string;
  readonly description: string;
  readonly dependencies?: readonly string[];
  /** Workspace package directories rendered as standalone Git dependencies. */
  readonly internalDependencies?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
  /** Publish this package through the Rust UniFFI release flow instead of the Python workflow. */
  readonly uniffi?: boolean;
  /** Generated source files excluded from strict static analysis. Package-relative. */
  readonly generatedSources?: readonly string[];
  /** Trusted publisher used outside the standard Python release workflow. */
  readonly trustedPublisher?: PythonTrustedPublisherOptions;
}

interface ResolvedPythonPackageOptions extends PythonPackageOptions {
  readonly name: string;
  readonly module: string;
}

/** GitHub Actions publisher for a Python package released by another workflow. */
export interface PythonTrustedPublisherOptions {
  readonly environment: string;
  readonly artifacts?: string;
}

/** Options for one projen-native Python workspace member. */
export interface DBXToolsPythonProjectOptions extends DBXToolsProjectOptions {
  readonly parent: Project;
  readonly package: ResolvedPythonPackageOptions;
  readonly repository: Required<PythonRepositoryOptions>;
  readonly requiresPython: string;
  /** Workspace version copied onto this package's `pyproject.toml`. */
  readonly version: string;
}

/** Python release workflow configuration. */
export interface PythonReleaseOptions {
  /** GitHub environment by Python distribution name. Defaults to `pypi-<name>`. */
  readonly environments?: Readonly<Record<string, string>>;
  readonly environmentUrl?: string;
}

interface PythonPublication {
  readonly directory: string;
  readonly distribution: string;
  readonly environment: string;
  readonly artifacts?: string;
  readonly dependencies?: readonly string[];
}

/** Options for {@link DBXToolsPythonWorkspace}. */
export interface DBXToolsPythonWorkspaceOptions {
  readonly packages: readonly PythonPackageOptions[];
  readonly repository?: PythonRepositoryOptions;
  /** Repository-relative Python package root. Defaults to `packages/py`. */
  readonly root?: string;
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

/** Derive a dotted Python module from an npm-style scope and package directory. */
export function pythonModuleName(scope: string, directory: string): string {
  return [scope, ...directory.split("/")].map((part) => part.replaceAll("-", "_")).join(".");
}

function projectVscode(project: Project): vscode.VsCode | undefined {
  return (project as Project & { readonly vscode?: vscode.VsCode }).vscode;
}

/** A Python package implemented with projen's `PythonProject` and uv backend. */
export class DBXToolsPythonProject extends python.PythonProject implements DBXToolsProject {
  readonly language = "python" as const;
  readonly packageOptions: ResolvedPythonPackageOptions;
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
    if (pkg.uniffi !== undefined) {
      this.uv.file.addOverride("tool.dbx_tools.config.uniffi", pkg.uniffi);
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
    const scope = isDBXToolsJavaScriptProject()(project)
      ? string.toSlug(project.scope)
      : string.toSlug(project.name).replace(/-root$/, "");
    const repositoryUrl =
      options.repository?.url ??
      projectRepositoryUrl(project) ??
      coreProject.repositoryUrl(project.outdir);
    if (!repositoryUrl) {
      throw new Error("Python workspace repository URL was not configured or detected");
    }
    this.repository = {
      url: repositoryUrl.endsWith(".git") ? repositoryUrl : `${repositoryUrl}.git`,
      ref: options.repository?.ref ?? "main",
      root: options.root ?? options.repository?.root ?? "packages/py",
    };
    const packageIdentities: ResolvedPythonPackageOptions[] = options.packages.map((pkg) => ({
      ...pkg,
      name: pkg.name ?? `${scope}-${string.toSlug(pkg.directory)}`,
      module: pkg.module ?? pythonModuleName(scope, pkg.directory),
    }));
    const packagesByDirectory = new Map(packageIdentities.map((pkg) => [pkg.directory, pkg]));
    const packages = packageIdentities.map((pkg) => ({
      ...pkg,
      dependencies: [
        ...(pkg.dependencies ?? []),
        ...(pkg.internalDependencies ?? []).map((directory) => {
          const dependency = packagesByDirectory.get(directory);
          if (!dependency) {
            throw new Error(
              `Python package ${pkg.directory} references unknown internal package ${directory}`,
            );
          }
          return pythonGitDependency(this.repository, dependency.name, dependency.directory);
        }),
      ],
    }));
    const resolvedOptions = { ...options, packages };
    this.requiresPython = options.requiresPython ?? ">=3.10";
    // The single workspace version, copied from the root `VERSION` file so Python
    // members carry the same number as their JS siblings.
    this.version = readWorkspaceVersion(project.outdir);
    this.file = this.emitWorkspace(project, resolvedOptions, scope);
    this.packages = packages.map(
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
    project.gitignore.addPatterns(
      ".venv/",
      ".pytest_cache/",
      ".ruff_cache/",
      "**/__pycache__/",
      "**/*.py[cod]",
      `${this.repository.root}/**/dist/`,
    );
    this.addTasks(project, resolvedOptions);

    const configuredReleaseOptions = options.release === true ? {} : options.release || {};
    const releaseOptions = { ...configuredReleaseOptions };
    this.addTrustedPublisherInstructionsTask(project, releaseOptions);

    const interpreterPath = options.interpreterPath ?? "${workspaceFolder}/.venv/bin/python";
    if (interpreterPath !== false) {
      projectVscode(project)?.settings.addSetting("python.defaultInterpreterPath", interpreterPath);
    }

    if (options.release && this.packages.length > 0) {
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
    scope: string,
  ): python.PyprojectTomlFile {
    const testPaths = options.testPaths ?? [this.repository.root];
    const perFileIgnores = options.ruffPerFileIgnores ?? {};
    const file = new python.PyprojectTomlFile(project, {
      project: {
        name: options.workspaceName ?? `${scope}-python-workspace`,
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
    const projectExcludes = [
      ...(options.pyreflyProjectExcludes ?? []),
      ...options.packages.flatMap((pkg) =>
        (pkg.generatedSources ?? []).map(
          (source) => `${this.repository.root}/${pkg.directory}/${source}`,
        ),
      ),
    ];
    if (projectExcludes.length) {
      file.addOverride("tool.pyrefly.project-excludes", [...new Set(projectExcludes)]);
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
    if (!project.github || !isDBXToolsJavaScriptProject()(project)) return;
    const publications = this.publications(options);
    const uniffiPublications = this.uniffiPublications(options);
    const allPublications = [...publications, ...uniffiPublications];
    if (allPublications.length === 0) return;
    const usesRustArtifacts = uniffiPublications.length > 0;
    const workflow = releaseWorkflow(project);
    workflow.addJob("build-python", {
      if: usesRustArtifacts
        ? "${{ always() && needs.verify-context.result == 'success' && needs.rust-build.result != 'failure' && needs.rust-build.result != 'cancelled' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'python') }}"
        : releaseStageCondition("python"),
      needs: ["verify-context", ...(usesRustArtifacts ? ["rust-build"] : [])],
      runsOn: ["ubuntu-latest"],
      permissions: { actions: JobPermission.READ, contents: JobPermission.READ },
      timeoutMinutes: 20,
      env: { BUN_VERSION },
      steps: [
        ...releaseSourceSteps(),
        ...bunCacheRestoreSteps(project),
        { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
        { name: "Install release helpers", run: "bun install" },
        bunCacheSaveStep(),
        ...uniffiPublications.flatMap((publication) =>
          releaseArtifactSteps({
            currentName: `Download ${publication.distribution} native wheels`,
            recoveredName: `Download recovered ${publication.distribution} native wheels`,
            pattern: `${publication.distribution}--*--python-wheel`,
            path: `dist/${publication.directory}`,
          }),
        ),
        {
          name: "Stamp workspace versions",
          env: { VERSION: RELEASE_VERSION },
          run: `bun node_modules/@dbx-tools/projen/tasks/stamp-python.ts "$VERSION" --root ${quote(this.repository.root)}`,
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
            ...publications.map(
              (publication) =>
                `test "$(find dist/${publication.directory} -maxdepth 1 -type f \\( -name '*.whl' -o -name '*.tar.gz' \\) | wc -l | tr -d ' ')" -eq 2`,
            ),
            ...uniffiPublications.map(
              (publication) =>
                `find dist/${publication.directory} -maxdepth 1 -name '*.whl' -print -quit | grep -q .`,
            ),
            "find dist -type f \\( -name '*.whl' -o -name '*.tar.gz' \\) -print0 | xargs -0 uvx twine check",
          ].join("\n"),
        },
        {
          name: "Upload distributions",
          uses: "actions/upload-artifact@v7",
          with: { name: "python-distributions", path: "dist", "retention-days": 7 },
        },
      ],
    });
    for (const publication of allPublications) {
      workflow.addJob(`publish-pypi-${publication.directory}`, {
        if: releasePublishCondition("python"),
        needs: [
          "verify-context",
          "build-python",
          ...(publication.dependencies ?? []).map((dependency) => `publish-pypi-${dependency}`),
        ],
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
            with: {
              "packages-dir": `dist/${publication.directory}`,
              "skip-existing": true,
            },
          },
        ],
      });
    }
  }

  private publications(options: PythonReleaseOptions): readonly PythonPublication[] {
    return this.packages
      .filter((pkg) => pkg.packageOptions.uniffi !== true)
      .map((pkg) => ({
        directory: pkg.packageOptions.directory,
        distribution: pkg.packageOptions.name,
        environment:
          options.environments?.[pkg.packageOptions.name] ?? `pypi-${pkg.packageOptions.name}`,
      }));
  }

  private uniffiPublications(options: PythonReleaseOptions): readonly PythonPublication[] {
    return this.packages
      .filter((pkg) => pkg.packageOptions.uniffi === true)
      .map((pkg) => ({
        directory: pkg.packageOptions.directory,
        distribution: pkg.packageOptions.name,
        environment:
          pkg.packageOptions.trustedPublisher?.environment ??
          options.environments?.[pkg.packageOptions.name] ??
          `pypi-${pkg.packageOptions.name}`,
        artifacts: pkg.packageOptions.trustedPublisher?.artifacts,
        dependencies: pkg.packageOptions.internalDependencies,
      }));
  }

  private trustedPublisherPublications(
    options: PythonReleaseOptions,
  ): readonly PythonPublication[] {
    const standard = new Map(
      this.publications(options).map((publication) => [publication.distribution, publication]),
    );
    for (const pkg of this.packages) {
      const publisher = pkg.packageOptions.trustedPublisher;
      if (!publisher || standard.has(pkg.packageOptions.name)) continue;
      standard.set(pkg.packageOptions.name, {
        directory: pkg.packageOptions.directory,
        distribution: pkg.packageOptions.name,
        environment: publisher.environment,
        artifacts: publisher.artifacts,
      });
    }
    return [...standard.values()];
  }

  private addTrustedPublisherInstructionsTask(
    project: javascript.NodeProject,
    options: PythonReleaseOptions,
  ): void {
    const repository = this.githubRepository();
    const publications = this.trustedPublisherPublications(options);
    const releaseTags = isDBXToolsJavaScriptProject()(project) ? releaseTagPattern(project) : "v*";
    const linesBeforeAuthentication = [
      "# PyPI Trusted Publisher Setup Instructions",
      "",
      "Use the system browser to audit and configure the PyPI trusted publishers below.",
      "Do not use an in-app browser or embedded webview.",
      "Do not visit GitHub or use the GitHub API or CLI. Every required GitHub owner, repository, workflow, environment, and tag value is provided below and is authoritative.",
      "Use only PyPI pages for this task.",
      "",
      "## Audit and confirmation",
      "",
      "Before making any changes, complete a read-only audit:",
      "",
      "- Confirm that the active PyPI account can administer the listed projects and pending publishers.",
      "- Start at https://pypi.org/manage/projects/ and determine which listed projects exist.",
      "- On PyPI, inspect every existing GitHub Actions publisher for each project and compare its owner, repository name, workflow name, and environment name with the desired values below.",
      "- Identify duplicate and mismatched trusted publishers that must be replaced by removing the publisher entry and adding the correct one.",
      "- For projects that do not exist, identify the pending publisher that must be created.",
      "- Report the active account and a proposed reconciliation plan grouped by publishers that will be left unchanged, updated, replaced, created, or removed.",
      "- Ask the user to confirm the complete proposed plan before submitting any change.",
      "- After confirmation, perform the authorized plan without asking for additional confirmation unless authentication or a CAPTCHA requires user action.",
      "",
      "## GitHub environment policy",
      "",
      `- The supplied tag policy value is ${releaseTags}.`,
      "- Do not inspect or configure GitHub environments during this task.",
      "- GitHub environment administration is a separate task; use the supplied values only when comparing PyPI publisher entries.",
      "",
      "## Authentication",
      "",
    ];
    const linesAfterAuthentication = [
      "- If the active account cannot administer the listed projects or pending publishers, pause and ask the user to sign in to an authorized account.",
      "- Pause and ask the user to complete every CAPTCHA. Do not attempt to solve or bypass a CAPTCHA.",
      "- After the user completes an authentication or CAPTCHA step, continue from the current browser session.",
      "",
      "## Efficient browser workflow",
      "",
      "- Reuse an existing PyPI tab in the system browser when available.",
      "- For an existing project, open its publisher page directly at https://pypi.org/manage/project/<project-name>/settings/publishing/.",
      "- For a project that does not exist, use the pending-publisher page at https://pypi.org/manage/account/publishing/.",
      "- Treat the publisher table shown after submission as authoritative confirmation of success, even if the navigation header unexpectedly appears signed out.",
      "- Platform-specific wheels for different operating systems and CPU architectures do not require separate PyPI projects or trusted publishers.",
      "",
      "## Reconciliation rules",
      "",
      "- Never delete a PyPI project or package. Every remove or delete action in these instructions applies only to a trusted publisher entry.",
      "- Treat editing or updating a trusted publisher as replacing that publisher: remove the existing publisher entry, then add the correct one.",
      "- If exactly one publisher matches, leave it unchanged.",
      "- If a publisher is mismatched, remove that trusted publisher entry and add the correct one.",
      "- If no publisher exists, create it.",
      "- Remove duplicates so exactly one matching publisher remains for each PyPI project and workflow.",
      "- Use a pending publisher only when the PyPI project does not exist.",
      "- After every change, verify that the resulting table displays the exact desired configuration.",
      "- At completion, report which publishers were unchanged, updated, replaced, created, or removed.",
      "",
      "Publisher type: GitHub Actions",
      "",
      ...publications.flatMap((publication) => {
        return [
          `## ${publication.distribution}`,
          `- Owner: ${repository.owner}`,
          `- Repository name: ${repository.name}`,
          "- Workflow name: release.yml",
          `- Environment name: ${publication.environment}`,
          `- GitHub environment tag: ${releaseTags}`,
          ...(publication.artifacts ? [`- Artifacts: ${publication.artifacts}`] : []),
          "",
        ];
      }),
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
      description: "Print system-browser instructions for PyPI trusted publishers",
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
}
