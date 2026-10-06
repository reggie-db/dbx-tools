/** Reusable uv workspace generation for Python packages hosted in a projen tree. */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { stringUtils, type OneOrMany } from "@dbx-tools/shared-core";
import { Component, License, TextFile, type Project, javascript, python } from "projen";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { DBX_TOOLS_LICENSE, projectRepositoryUrl } from "./project-js.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";
import { PythonNodeBundle, type PythonNodeBindingsOptions } from "./python-node-bundle.ts";
import {
  refreshReleaseDocsDependencies,
  releaseCondition,
  releaseBuildSteps,
  releaseTagPattern,
  tryReleaseWorkflow,
  uvSetupStep,
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
  /** Python import root. Defaults to `generated-src` for generated packages, otherwise `src`. */
  readonly moduleRoot?: string;
  readonly description: string;
  readonly dependencies?: readonly string[];
  /** Workspace package directories rendered as standalone Git dependencies. */
  readonly internalDependencies?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
  /** One or more build-time Node packages embedded through PythonMonkey. */
  readonly nodeBindings?: OneOrMany<PythonNodeBindingsOptions>;
  /** Generated source files excluded from strict static analysis. Package-relative. */
  readonly generatedSources?: readonly string[];
}

interface ResolvedPythonPackageOptions extends PythonPackageOptions {
  readonly name: string;
  readonly module: string;
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
  /** Repository-relative paths Ruff must not lint or format. */
  readonly ruffExcludes?: readonly string[];
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

/** Repository-relative path for a Python package directory. */
export function pythonPackagePath(repository: PythonRepositoryOptions, directory: string): string {
  return `${repository.root ?? "packages/py"}/${directory}`;
}

/** Derive a dotted Python module from an npm-style scope and package directory. */
export function pythonModuleName(scope: string, directory: string): string {
  return [scope, ...directory.split("/")].map((part) => part.replaceAll("-", "_")).join(".");
}

/** A Python package implemented with projen's `PythonProject` and uv backend. */
export class DBXToolsPythonProject extends python.PythonProject implements DBXToolsProject {
  readonly language = "python" as const;
  readonly packageOptions: ResolvedPythonPackageOptions;
  readonly uv: python.Uv;

  constructor(options: DBXToolsPythonProjectOptions) {
    const pkg = options.package;
    const nodeBindings = pythonNodeBindings(pkg);
    super({
      parent: options.parent,
      outdir: pythonPackagePath(options.repository, pkg.directory),
      name: pkg.name,
      moduleName: pkg.module,
      authorName: "",
      authorEmail: "",
      version: options.version,
      description: pkg.description,
      license: DBX_TOOLS_LICENSE,
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
          licenseFiles: ["LICENSE"],
          requiresPython: options.requiresPython,
          dependencies: [...(pkg.dependencies ?? [])],
          scripts: pkg.scripts,
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
            moduleRoot: pkg.moduleRoot ?? "src",
            namespace: true,
          },
        },
      },
    });
    new License(this, { spdx: DBX_TOOLS_LICENSE });
    this.packageOptions = pkg;
    if (!(this.packagingManager instanceof python.Uv)) {
      throw new Error(`Expected uv packaging for ${pkg.name}`);
    }
    this.uv = this.packagingManager;
    this.tasks.removeTask("publish");
    this.tasks.removeTask("publish:test");
    this.uv.file.addDeletionOverride("project.authors");
    this.uv.file.addDeletionOverride("dependency-groups");
    if (nodeBindings.length > 0) {
      const rendered = nodeBindings.map(renderPythonNodeBindings);
      this.uv.file.addOverride(
        "tool.dbx_tools.node_bindings",
        rendered.length === 1 ? rendered[0] : rendered,
      );
    }
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
      ? stringUtils.toSlug(project.scope)
      : stringUtils.toSlug(project.name).replace(/-root$/, "");
    const repositoryUrl =
      options.repository?.url ??
      projectRepositoryUrl(project) ??
      projectUtils.repositoryUrl(project.outdir);
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
      name: pkg.name ?? `${scope}-${stringUtils.toSlug(pkg.directory)}`,
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
          return dependency.name;
        }),
      ],
    }));
    const resolvedOptions = { ...options, packages };
    this.requiresPython = options.requiresPython ?? ">=3.10";
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
      const bindings = pythonNodeBindings(pkg.packageOptions);
      if (bindings.length === 0) continue;
      new PythonNodeBundle(project, {
        name: pkg.packageOptions.directory,
        projectDirectory: pythonPackagePath(this.repository, pkg.packageOptions.directory),
      });
    }
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
      project.vscode?.settings.addSetting("python.defaultInterpreterPath", interpreterPath);
    }

    if (options.release && this.packages.length > 0) {
      this.addReleaseWorkflow(project, releaseOptions);
    }
  }

  /** Repository-relative package directory. */
  packagePath(directory: string): string {
    return pythonPackagePath(this.repository, directory);
  }

  private emitWorkspace(
    project: javascript.NodeProject,
    options: Omit<DBXToolsPythonWorkspaceOptions, "packages"> & {
      readonly packages: readonly ResolvedPythonPackageOptions[];
    },
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
    const ruffExcludes = [
      ...(options.ruffExcludes ?? []),
      ...options.packages.flatMap((pkg) =>
        pythonNodeGeneratedSources(pkg).map(
          (source) => `${this.repository.root}/${pkg.directory}/${source}`,
        ),
      ),
    ];
    if (ruffExcludes.length) {
      file.addOverride("tool.ruff.exclude", [...new Set(ruffExcludes)]);
    }
    file.addOverride("tool.pyrefly.ignore-errors-in-generated-code", true);
    const projectExcludes = [
      ...(options.pyreflyProjectExcludes ?? []),
      ...options.packages.flatMap((pkg) =>
        [...(pkg.generatedSources ?? []), ...pythonNodeGeneratedSources(pkg)].map(
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
    const allPublications = publications;
    if (allPublications.length === 0) return;
    const workflow = tryReleaseWorkflow(project);
    if (!workflow) {
      throw new Error("Python release requires the root dbx-tools release mode");
    }
    const build = workflow.getJob("build-release") as Job | undefined;
    if (!build) throw new Error("Python release requires the shared release build job");
    const pythonSteps: JobStep[] = [
      uvSetupStep(),
      {
        name: "Build Python distributions",
        env: { RELEASE_VERSION: "${{ steps.release.outputs.release_version }}" },
        run: [
          'bun node_modules/@dbx-tools/projen/tasks/publish-python.ts "$RELEASE_VERSION"',
          `--root ${JSON.stringify(this.repository.root)}`,
          `--package ${allPublications.map((publication) => JSON.stringify(publication.directory)).join(" ")}`,
          "--output .release/python --package-directories",
        ].join(" \\\n  "),
      },
      ...allPublications.map((publication) => ({
        name: `Upload ${publication.distribution} distributions`,
        uses: "actions/upload-artifact@v4",
        with: {
          name: `release-python-${publication.directory}`,
          path: `.release/python/${publication.directory}`,
          "if-no-files-found": "error",
        },
      })),
    ];
    workflow.updateJob("build-release", {
      ...build,
      steps: [...build.steps, ...releaseBuildSteps("pypi", pythonSteps)],
    });
    for (const publication of allPublications) {
      const dependencyJobs = (publication.dependencies ?? []).map(
        (dependency) => `publish-pypi-${dependency}`,
      );
      workflow.addJob(`publish-pypi-${publication.directory}`, {
        if: releaseCondition([
          "needs.build-release.result == 'success'",
          "needs.build-release.outputs.pypi == 'true'",
          ...dependencyJobs.map((job) => `needs['${job}'].result == 'success'`),
        ]),
        needs: ["build-release", ...dependencyJobs],
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
            name: `Download ${publication.distribution} distributions`,
            uses: "actions/download-artifact@v4",
            with: {
              name: `release-python-${publication.directory}`,
              path: `dist/${publication.directory}`,
            },
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
    refreshReleaseDocsDependencies(project);
  }

  private publications(options: PythonReleaseOptions): readonly PythonPublication[] {
    return this.packages.map((pkg) => ({
      directory: pkg.packageOptions.directory,
      distribution: pkg.packageOptions.name,
      environment:
        options.environments?.[pkg.packageOptions.name] ?? `pypi-${pkg.packageOptions.name}`,
      dependencies: pkg.packageOptions.internalDependencies,
    }));
  }

  private addTrustedPublisherInstructionsTask(
    project: javascript.NodeProject,
    options: PythonReleaseOptions,
  ): void {
    const repository = this.githubRepository();
    const publications = this.publications(options);
    const releaseTag =
      isDBXToolsJavaScriptProject()(project) && tryReleaseWorkflow(project)
        ? releaseTagPattern(project)
        : "v*";
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
      `- The supplied deployment tag policy value is ${releaseTag}.`,
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
          `- GitHub environment tag: ${releaseTag}`,
          "",
        ];
      }),
    ];
    const helper = ".projen/pypi-trusted-publisher-instructions.mjs";
    new TextFile(project.root, helper, {
      // prettier-ignore
      lines: stringUtils.dedent(
        // ============================================================================
        /*js*/`
          #!/usr/bin/env node
          import { parseArgs } from "node:util";

          const { values } = parseArgs({
            options: { secretFile: { type: "string" } },
          });
          const beforeAuthentication = ${JSON.stringify(linesBeforeAuthentication)};
          const afterAuthentication = ${JSON.stringify(linesAfterAuthentication)};
          const authentication = values.secretFile
            ? [
                \`- If browser authentication is required, read credentials from \${values.secretFile} directly into the browser without printing, logging, or exposing secret values.\`,
                \`- If \${values.secretFile} is absent, invalid, or insufficient for authentication, pause and ask the user to complete authentication.\`,
              ]
            : ["- If browser authentication is required, pause and ask the user to complete authentication."];
          process.stdout.write(\`\${[...beforeAuthentication, ...authentication, ...afterAuthentication].join("\\n").trimEnd()}\\n\`);
        `
        // ============================================================================
      ).split("\n"),
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

function pythonNodeBindings(
  pkg: Pick<PythonPackageOptions, "nodeBindings">,
): readonly PythonNodeBindingsOptions[] {
  if (!pkg.nodeBindings) return [];
  return Array.isArray(pkg.nodeBindings) ? pkg.nodeBindings : [pkg.nodeBindings];
}

function renderPythonNodeBindings(binding: PythonNodeBindingsOptions): Record<string, unknown> {
  return {
    package: binding.package,
    ...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
    ...(binding.modules?.length ? { modules: binding.modules } : {}),
    ...(binding.functionOverrides?.length
      ? {
          function_overrides: binding.functionOverrides.map((override) => ({
            module: override.module,
            export: override.export,
            handler: override.handler,
            ...(override.handlerExport ? { handler_export: override.handlerExport } : {}),
          })),
        }
      : {}),
  };
}

function pythonNodeGeneratedSources(pkg: ResolvedPythonPackageOptions): string[] {
  const bindings = pythonNodeBindings(pkg);
  if (bindings.length === 0) return [];
  const moduleRoot = pkg.moduleRoot ?? "src";
  const moduleDirectory = `${moduleRoot}/${pkg.module.replaceAll(".", "/")}`;
  return [`${moduleDirectory}/_generated/**`];
}
