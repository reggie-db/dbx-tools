/** Reusable uv workspace generation for Python packages hosted in a projen tree. */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { stringUtils, type OneOrMany } from "@dbx-tools/shared-core";
import { Component, License, TextFile, type Project, github, javascript, python } from "projen";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { PYTHON_GENERATED_PACKAGE } from "./generated.ts";
import { LICENSE, projectRepositoryUrl, taskCommand } from "./project-js.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";
import {
  PythonNodeBindings,
  type PythonNodeBindingsOptions,
} from "./python-node-bindings-component.ts";
import {
  PYTHON_NODE_RUNTIME_DISTRIBUTION,
  PYTHON_NODE_RUNTIME_MODULE,
  PythonNodeRuntime,
} from "./python-node-runtime.ts";
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
  /** Python source root passed to uv_build. Defaults to `src`. */
  readonly moduleRoot?: string;
  readonly description: string;
  readonly dependencies?: readonly string[];
  /** Named PEP 621 optional dependency groups emitted under `project.optional-dependencies`. */
  readonly optionalDependencies?: Readonly<Record<string, readonly string[]>>;
  /** Development dependencies emitted only in this package's dependency group. */
  readonly devDependencies?: readonly string[];
  /** Workspace package directories rendered as standalone Git dependencies. */
  readonly internalDependencies?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
  /** GitHub environment used to publish this distribution to PyPI. */
  readonly releaseEnvironment?: string;
  /** Mark this package as the shared PythonMonkey runtime and Node shim owner. */
  readonly nodeRuntime?: boolean;
  /** One or more build-time Node packages embedded through PythonMonkey. */
  readonly nodeBindings?: OneOrMany<PythonNodeBindingsOptions>;
  /** Pinned Git source subsets synchronized into this package's generated tree. */
  readonly sync?: readonly PythonSourceSyncOptions[];
}

/** One pip-style Git source synchronized into a generated Python package tree. */
export interface PythonSourceSyncOptions {
  readonly name?: string;
  readonly source: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Literal text patches applied to each synchronized `.py` file before import localization. */
  readonly replace?: Readonly<Record<string, string>>;
  /**
   * Rewrite absolute imports of synchronized modules to the generated package they now
   * live in, using the Python AST. `true` detects every top-level synchronized module,
   * importable either bare (`config.schema`) or under the source subdirectory's dotted
   * path (`graphiti_core.driver.postgraph`). A list names the upstream modules to rewrite
   * instead, and each entry must match at least one import. Defaults to `true` when the
   * sync `name` is a Python identifier; set `false` to keep upstream imports unchanged.
   */
  readonly localizeImports?: boolean | readonly string[];
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
  /** Python version installed in validation, documentation, and release workflows. */
  readonly workflowPythonVersion?: string;
  readonly workspaceName?: string;
  /** Dependencies appended to the standard development group. */
  readonly devDependencies?: readonly string[];
  readonly testPaths?: readonly string[];
  readonly lintPaths?: readonly string[];
  /** Repository-relative paths Ruff must not lint or format. */
  readonly ruffExcludes?: readonly string[];
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
const DEFAULT_RUFF_TARGET = "py310";
const RELEASE_SETUP_CONDITION =
  "${{ steps.release.outputs.validation == 'true' || steps.release.outputs.docs == 'true' || steps.release.outputs.pypi == 'true' }}";

/** Convert Ruff's `py311` target spelling to the setup-python `3.11` spelling. */
function pythonVersionFromRuffTarget(target: string): string {
  const match = /^py(\d)(\d{1,2})$/.exec(target);
  if (!match) throw new Error(`Cannot derive a workflow Python version from Ruff target ${target}`);
  return `${match[1]}.${match[2]}`;
}

/** Python and uv setup steps, optionally gated by a workflow expression. */
function pythonSetupSteps(pythonVersion: string, condition?: string): JobStep[] {
  return [
    {
      name: "Setup Python",
      uses: github.ActionRefs.ACTIONS_SETUP_PYTHON,
      ...(condition ? { if: condition } : {}),
      with: { "python-version": pythonVersion },
    },
    {
      ...uvSetupStep(),
      ...(condition ? { if: condition } : {}),
    },
  ];
}

/** Materialize Projen's lazily rendered native build steps before extending them. */
function resolvedJobSteps(job: Job): JobStep[] {
  const steps = (job as unknown as { steps: JobStep[] | (() => JobStep[]) }).steps;
  return typeof steps === "function" ? steps() : steps;
}

function missingSetupSteps(job: Job, setupSteps: readonly JobStep[]): JobStep[] {
  const actionName = (step: JobStep): string | undefined => step.uses?.split("@", 1)[0];
  const existing = new Set(resolvedJobSteps(job).map(actionName));
  return setupSteps.filter((step) => !existing.has(actionName(step)));
}

/**
 * Ensure Python and uv are available before validation, docs, and packaging.
 *
 * The Python workspace owns these prerequisites. Existing action steps are
 * reused so repository-specific setup can override a version without causing a
 * duplicate installation.
 */
function withPythonBuildSetup(job: Job, pythonVersion: string): Job {
  const setupSteps = missingSetupSteps(
    job,
    pythonSetupSteps(pythonVersion, RELEASE_SETUP_CONDITION),
  );
  if (setupSteps.length === 0) return job;
  const steps = resolvedJobSteps(job);
  const verificationIndex = steps.findIndex((step) => step.name === "Verify release context");
  const validationIndex = steps.findIndex((step) => step.name?.startsWith("Validate "));
  const insertionIndex =
    verificationIndex >= 0
      ? verificationIndex + 1
      : validationIndex < 0
        ? steps.length
        : validationIndex;
  return {
    ...job,
    steps: [...steps.slice(0, insertionIndex), ...setupSteps, ...steps.slice(insertionIndex)],
  };
}

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
      license: LICENSE,
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
          optionalDependencies: pkg.optionalDependencies,
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
    new License(this, { spdx: LICENSE });
    this.packageOptions = pkg;
    if (!(this.packagingManager instanceof python.Uv)) {
      throw new Error(`Expected uv packaging for ${pkg.name}`);
    }
    this.uv = this.packagingManager;
    this.tasks.removeTask("publish");
    this.tasks.removeTask("publish:test");
    this.uv.file.addDeletionOverride("project.authors");
    if (pkg.devDependencies?.length) {
      this.uv.file.addOverride("dependency-groups.dev", [...pkg.devDependencies]);
    } else {
      this.uv.file.addDeletionOverride("dependency-groups");
    }
    if (nodeBindings.length > 0) {
      const rendered = nodeBindings.map(renderPythonNodeBindings);
      this.uv.file.addOverride(
        "tool.dbx_tools.node_bindings",
        rendered.length === 1 ? rendered[0] : rendered,
      );
    }
    if (pkg.sync?.length) {
      this.uv.file.addOverride(
        "tool.dbx_tools.sync",
        pkg.sync.map(({ localizeImports, ...sync }) => ({
          ...sync,
          ...(localizeImports === undefined ? {} : { localize_imports: localizeImports }),
        })),
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
 *
 * Native `PythonProject` and `PyprojectTomlFile` continue to own each package
 * and TOML rendering. This component owns only the unsupported remainder:
 * attaching several uv members to an existing JavaScript root and adding their
 * dependency-ordered artifacts to the repository's shared tag release.
 */
export class DBXToolsPythonWorkspace extends Component {
  readonly packages: readonly DBXToolsPythonProject[];
  readonly repository: Required<PythonRepositoryOptions>;
  readonly requiresPython: string;
  readonly version: string;
  /** Exact Python version used by the shared release build. */
  readonly workflowPythonVersion: string;
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
    const configuredNodeRuntimes = packageIdentities.filter(({ nodeRuntime }) => nodeRuntime);
    if (configuredNodeRuntimes.length > 1) {
      throw new Error("A Python workspace can configure only one shared Node runtime package");
    }
    const configuredNodeRuntime = configuredNodeRuntimes[0];
    if (
      configuredNodeRuntime &&
      (configuredNodeRuntime.name !== PYTHON_NODE_RUNTIME_DISTRIBUTION ||
        configuredNodeRuntime.module !== PYTHON_NODE_RUNTIME_MODULE)
    ) {
      throw new Error(
        `The shared Node runtime package must use distribution ${PYTHON_NODE_RUNTIME_DISTRIBUTION} ` +
          `and module ${PYTHON_NODE_RUNTIME_MODULE}`,
      );
    }
    this.version = readWorkspaceVersion(project.outdir);
    const packagesByDirectory = new Map(packageIdentities.map((pkg) => [pkg.directory, pkg]));
    const nodeRuntimePackage = configuredNodeRuntime;
    const packages = packageIdentities.map((pkg) => {
      const usesNodeRuntime = pythonNodeBindings(pkg).length > 0;
      const internalDependencies = [
        ...new Set([
          ...(pkg.internalDependencies ?? []),
          ...(usesNodeRuntime &&
          nodeRuntimePackage &&
          nodeRuntimePackage.directory !== pkg.directory
            ? [nodeRuntimePackage.directory]
            : []),
        ]),
      ];
      const dependencies = [
        ...(pkg.dependencies ?? []),
        ...internalDependencies.map((directory) => {
          const dependency = packagesByDirectory.get(directory);
          if (!dependency) {
            throw new Error(
              `Python package ${pkg.directory} references unknown internal package ${directory}`,
            );
          }
          return usesNodeRuntime && dependency.name === PYTHON_NODE_RUNTIME_DISTRIBUTION
            ? `${dependency.name}==${this.version}`
            : dependency.name;
        }),
        ...(usesNodeRuntime && !nodeRuntimePackage
          ? [`${PYTHON_NODE_RUNTIME_DISTRIBUTION}==${this.version}`]
          : []),
      ];
      return {
        ...pkg,
        dependencies: [...new Set(dependencies)],
        internalDependencies,
      };
    });
    const resolvedOptions = { ...options, packages };
    this.requiresPython = options.requiresPython ?? ">=3.10";
    this.workflowPythonVersion =
      options.workflowPythonVersion ??
      pythonVersionFromRuffTarget(options.ruffTarget ?? DEFAULT_RUFF_TARGET);
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
    const syncWatchTasks: string[] = [];
    if (configuredNodeRuntime) {
      const runtime = new PythonNodeRuntime(project, {
        projectDirectory: pythonPackagePath(this.repository, configuredNodeRuntime.directory),
      });
      syncWatchTasks.push(runtime.watchTask.name);
    }
    if (this.packages.some((pkg) => pythonNodeBindings(pkg.packageOptions).length > 0)) {
      const bindings = new PythonNodeBindings(project);
      syncWatchTasks.push(bindings.watchTask.name);
    }
    if (syncWatchTasks.length && isDBXToolsJavaScriptProject()(project)) {
      project.dbxToolsConfig.syncWatchTasks.push(...syncWatchTasks);
    }
    for (const pkg of this.packages) {
      if (!pkg.packageOptions.sync?.length) continue;
      const directory = pythonPackagePath(this.repository, pkg.packageOptions.directory);
      const command = taskCommand("python-sync.ts", "--project", directory);
      const sync = project.addTask(`${pkg.packageOptions.directory}:python-sync`, {
        description: `Synchronize generated Git sources for ${pkg.packageOptions.name}`,
        execArgs: command,
      });
      const check = project.addTask(`${pkg.packageOptions.directory}:python-sync:check`, {
        description: `Verify generated Git sources for ${pkg.packageOptions.name}`,
        execArgs: [...command, "--check"],
      });
      project.preCompileTask.spawn(sync);
      project.testTask.spawn(check);
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
    this.addBuildWorkflowSetup(project);

    const configuredReleaseOptions = options.release === true ? {} : options.release || {};
    const releaseOptions = { ...configuredReleaseOptions };
    this.addTrustedPublisherInstructionsTask(project);

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
        dev: [...DEFAULT_DEV_DEPENDENCIES, ...(options.devDependencies ?? [])],
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
          "target-version": options.ruffTarget ?? DEFAULT_RUFF_TARGET,
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
    const lint = project.addTask("py:lint", {
      exec: `uv run ruff check ${lintPaths.join(" ")}`,
      description: "Lint Python workspace packages",
    });
    lint.exec(`uv run ruff format --check ${lintPaths.join(" ")}`);
    project.addTask("py:format", {
      exec: `uv run ruff format ${lintPaths.join(" ")}`,
      description: "Format Python workspace packages",
    });
    project.addTask("py:build", {
      exec: "uv build --all-packages",
      description: "Build every Python workspace package",
    });
  }

  /** Add Python prerequisites to Projen's native build workflow when enabled. */
  private addBuildWorkflowSetup(project: javascript.NodeProject): void {
    const workflow = project.buildWorkflow?.workflow;
    const jobId = project.buildWorkflowJobId;
    if (!workflow || !jobId) return;
    const job = workflow.getJob(jobId) as Job | undefined;
    if (!job) return;
    const setupSteps = missingSetupSteps(job, pythonSetupSteps(this.workflowPythonVersion));
    if (setupSteps.length === 0) return;
    const steps = resolvedJobSteps(job);
    const buildIndex = steps.findIndex((step) => step.name === "build");
    const insertionIndex = buildIndex < 0 ? steps.length : buildIndex;
    workflow.updateJob(jobId, {
      ...job,
      steps: [...steps.slice(0, insertionIndex), ...setupSteps, ...steps.slice(insertionIndex)],
    });
  }

  private addReleaseWorkflow(project: javascript.NodeProject, options: PythonReleaseOptions): void {
    if (!project.github || !isDBXToolsJavaScriptProject()(project)) return;
    const publications = this.publications();
    const allPublications = publications;
    if (allPublications.length === 0) return;
    const workflow = tryReleaseWorkflow(project);
    if (!workflow) {
      throw new Error("Python release requires the root dbx-tools release mode");
    }
    const configuredBuild = workflow.getJob("build-release") as Job | undefined;
    if (!configuredBuild) throw new Error("Python release requires the shared release build job");
    const build = withPythonBuildSetup(configuredBuild, this.workflowPythonVersion);
    const pythonSteps: JobStep[] = [
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
        uses: github.ActionRefs.ACTIONS_UPLOAD_ARTIFACT,
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
            uses: github.ActionRefs.ACTIONS_DOWNLOAD_ARTIFACT,
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
            },
          },
        ],
      });
    }
    refreshReleaseDocsDependencies(project);
  }

  private publications(): readonly PythonPublication[] {
    return this.packages.map((pkg) => ({
      directory: pkg.packageOptions.directory,
      distribution: pkg.packageOptions.name,
      environment: pkg.packageOptions.releaseEnvironment ?? `pypi-${pkg.packageOptions.name}`,
      dependencies: pkg.packageOptions.internalDependencies,
    }));
  }

  private addTrustedPublisherInstructionsTask(project: javascript.NodeProject): void {
    const repository = this.githubRepository();
    const publications = this.publications();
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
          #!/usr/bin/env bun
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
      exec: `bun ${helper}`,
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
  return [`${moduleDirectory}/${PYTHON_GENERATED_PACKAGE}/**`];
}
