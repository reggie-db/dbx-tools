/** Unified default-branch release workflow generation. */
import { stringUtils } from "@dbx-tools/shared-core";
import { Component, github } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION } from "./bun-workflow.ts";
import { projectReleaseBranch, taskCommand, type DBXToolsJavaScriptProject } from "./project-js.ts";
import { RELEASE_TAG, RELEASE_VERSION, releaseSourceSteps } from "./release-context.ts";

const NODE_VERSION = "24";
const NPM_VERSION = "11.4.2";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();

/** GitHub Pages configuration included in the unified release workflow. */
export interface ReleaseDocsOptions {
  readonly siteUrl: string;
  readonly base?: string;
  /** Repository-defined setup and generation steps run before saving the Bun cache. */
  readonly prepareSteps: readonly JobStep[];
  /** Repository-defined documentation build and validation steps. */
  readonly buildSteps: readonly JobStep[];
  /** Directory uploaded as the GitHub Pages artifact. */
  readonly artifactPath: string;
}

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /** Git tag prefix. Defaults to `v`. */
  readonly tagPrefix?: string;
  /** Omit normal npm workspace publication while retaining other release jobs. */
  readonly nodeRelease?: boolean;
  /** Build and deploy generated documentation through GitHub Pages. */
  readonly docs?: ReleaseDocsOptions;
  /** Python package root used by attached Python publication jobs. */
  readonly pythonRoot?: string;
  /** Repository task names run after VERSION verification and before publication. */
  readonly validationTasks?: readonly string[];
}

/** Locate the unified workflow when release generation is enabled. */
export function tryReleaseWorkflow(project: DBXToolsJavaScriptProject): GithubWorkflow | undefined {
  return releaseWorkflows.get(project);
}

/** Tag pattern created by release jobs and accepted by manual recovery. */
export function releaseTagPattern(project: DBXToolsJavaScriptProject): string {
  const prefix = releaseTagPrefixes.get(project);
  if (!prefix) throw new Error("Release workflow is not configured");
  return `${prefix}*`;
}

/** Run a release job after all explicit prerequisite results succeed. */
export function releaseCondition(prerequisites: readonly string[] = []): string {
  if (prerequisites.length === 0) return "${{ success() }}";
  return `\${{ always() && ${prerequisites.map((condition) => `(${condition})`).join(" && ")} }}`;
}

/** Native project setup plus npm publication authentication. */
export function nodeReleaseSetupSteps(project: DBXToolsJavaScriptProject): readonly JobStep[] {
  return [
    ...releaseSourceSteps(),
    ...project.renderWorkflowSetup({ mutable: false }),
    {
      name: "Setup Node.js",
      uses: "actions/setup-node@v6",
      with: {
        "node-version": NODE_VERSION,
        "registry-url": NPM_REGISTRY_URL,
        "package-manager-cache": false,
      },
    },
    { name: "Install npm CLI", run: `npm install --global npm@${NPM_VERSION}` },
  ];
}

/** Install uv and restore its download/build cache using Python manifests. */
export function uvSetupStep(): JobStep {
  return {
    name: "Setup uv",
    uses: "astral-sh/setup-uv@v7",
    with: {
      "enable-cache": true,
      "cache-dependency-glob": "**/pyproject.toml",
    },
  };
}

function refreshDocsRegistryDependencies(workflow: GithubWorkflow): void {
  const docs = workflow.getJob("build-docs") as Job | undefined;
  if (!docs) return;
  const registryJobs = Object.keys(workflow.jobs).filter(
    (name) => name === "publish-node" || name.startsWith("publish-pypi-"),
  );
  if (registryJobs.length > 0) {
    workflow.updateJob("build-docs", { ...docs, needs: ["verify-context", ...registryJobs] });
  }
}

function refreshGitHubReleaseDependencies(workflow: GithubWorkflow): void {
  const release = workflow.getJob("publish-github-release") as Job | undefined;
  if (!release) return;
  const registryJobs = Object.keys(workflow.jobs).filter(
    (name) => name === "publish-node" || name.startsWith("publish-pypi-"),
  );
  const needs = ["verify-context", ...registryJobs];
  workflow.updateJob("publish-github-release", {
    ...release,
    needs,
    if: releaseCondition([
      "needs.verify-context.result == 'success'",
      ...registryJobs.map((job) => `needs['${job}'].result == 'success'`),
    ]),
  });
}

/** Keep documentation publication behind every configured package registry. */
export function refreshReleaseDocsDependencies(project: DBXToolsJavaScriptProject): void {
  const workflow = releaseWorkflows.get(project);
  if (workflow) {
    refreshDocsRegistryDependencies(workflow);
    refreshGitHubReleaseDependencies(workflow);
  }
}

function githubReleaseJob(): Job {
  return {
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    timeoutMinutes: 10,
    env: {
      GH_TOKEN: "${{ github.token }}",
      RELEASE_TAG,
    },
    steps: [
      {
        name: "Create GitHub release",
        run: [
          'gh release view "$RELEASE_TAG" >/dev/null 2>&1 ||',
          '  gh release create "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --generate-notes',
        ].join("\n"),
      },
    ],
  };
}

function verifyContextJob(
  project: DBXToolsJavaScriptProject,
  tagPrefix: string,
  releaseBranch: string,
  options: DBXToolsReleaseOptions,
): Job {
  return {
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    outputs: {
      release_tag: { stepId: "release", outputName: "release_tag" },
      expected_sha: { stepId: "release", outputName: "expected_sha" },
      release_version: { stepId: "release", outputName: "release_version" },
    },
    steps: [
      github.WorkflowSteps.checkout({
        name: "Checkout release source",
        with: {
          ref: "${{ github.ref_name }}",
          fetchDepth: 0,
        },
      }),
      ...project.renderWorkflowSetup({ mutable: false }),
      {
        name: "Verify release context",
        id: "release",
        shell: "bash",
        env: {
          RELEASE_TAG: "${{ github.ref_name }}",
        },
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          case "$RELEASE_TAG" in ${tagPrefix}*) ;; *) exit 1 ;; esac
          RELEASE_VERSION="\${RELEASE_TAG#${tagPrefix}}"
          bun node_modules/@dbx-tools/projen/tasks/release-version.ts --version "$RELEASE_VERSION"
          git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
          git fetch --force origin "+refs/heads/${releaseBranch}:refs/remotes/origin/${releaseBranch}"
          test "$(git cat-file -t "$RELEASE_TAG")" = "tag"
          RELEASE_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"
          test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
          test "$(git rev-parse "origin/${releaseBranch}")" = "$RELEASE_SHA"
          test "$(tr -d '\\r\\n' < VERSION)" = "$RELEASE_VERSION"
          echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"
          echo "expected_sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"
          echo "release_version=$RELEASE_VERSION" >> "$GITHUB_OUTPUT"
        `
          // ============================================================================
        ),
      },
      ...(options.validationTasks ?? []).map((task) => ({
        name: `Validate ${task}`,
        run: `bun run ${task}`,
      })),
    ],
  };
}

function nodePublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: releaseCondition(),
    needs: ["verify-context"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      {
        name: "Publish npm workspace",
        env: {
          RELEASE_VERSION,
          NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
          NPM_CONFIG_PROVENANCE: "true",
        },
        run: 'bun node_modules/@dbx-tools/projen/tasks/publish.ts "$RELEASE_VERSION" $DRY_RUN',
      },
    ],
  };
}

function addDocsJobs(
  workflow: GithubWorkflow,
  project: DBXToolsJavaScriptProject,
  options: ReleaseDocsOptions,
): void {
  workflow.addJob("build-docs", {
    if: releaseCondition(),
    needs: ["verify-context"],
    runsOn: ["ubuntu-latest"],
    permissions: {
      contents: JobPermission.READ,
      pages: JobPermission.WRITE,
      idToken: JobPermission.WRITE,
    },
    timeoutMinutes: 30,
    env: {
      BUN_VERSION,
      DOCS_SITE_URL: options.siteUrl,
      DOCS_BASE: options.base ?? "/",
    },
    steps: [
      ...releaseSourceSteps(),
      ...project.renderWorkflowSetup({ mutable: false }),
      ...options.prepareSteps,
      ...options.buildSteps,
      {
        name: "Upload Pages artifact",
        uses: "actions/upload-pages-artifact@v4",
        with: { path: options.artifactPath },
      },
    ],
  });
  workflow.addJob("deploy-docs", {
    if: releaseCondition(),
    needs: ["build-docs"],
    environment: {
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    },
    runsOn: ["ubuntu-latest"],
    permissions: { pages: JobPermission.WRITE, idToken: JobPermission.WRITE },
    timeoutMinutes: 15,
    steps: [
      {
        name: "Deploy to GitHub Pages",
        id: "deployment",
        uses: "actions/deploy-pages@v4",
      },
    ],
  });
  refreshDocsRegistryDependencies(workflow);
}

/** Owns the single release workflow and local release preparation tasks. */
export class DBXToolsRelease extends Component {
  constructor(project: DBXToolsJavaScriptProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    const tagPrefix = options.tagPrefix ?? "v";
    const releaseBranch = projectReleaseBranch(project);
    releaseTagPrefixes.set(project, tagPrefix);
    project.addTask("bump", {
      execArgs: taskCommand("bump.ts"),
      receiveArgs: true,
      description: "Increment VERSION and synchronize generated workspace versions",
    });
    project.addTask("version:check", {
      execArgs: taskCommand("version-check.ts"),
      description: "Verify every package and generated barrel matches VERSION",
    });
    if (project.github) {
      project.addTask("release", {
        execArgs: taskCommand(
          "release.ts",
          "--prefix",
          tagPrefix,
          "--branch",
          releaseBranch,
          ...(options.pythonRoot ? ["--python-root", options.pythonRoot] : []),
          ...(options.validationTasks ?? []).flatMap((task) => ["--validate", task]),
        ),
        receiveArgs: true,
        description: "Run bump, commit it, and push an annotated release tag",
      });
    }
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: {
        group: "release-${{ github.ref_name }}",
        cancelInProgress: false,
      },
    });
    releaseWorkflows.set(project, workflow);
    workflow.runName = "release ${{ github.ref_name }}";
    workflow.on({
      push: { tags: [`${tagPrefix}*`] },
    });
    workflow.file?.addOverride("permissions.contents", "read");
    workflow.addJob("verify-context", verifyContextJob(project, tagPrefix, releaseBranch, options));
    if (options.nodeRelease !== false) {
      workflow.addJob("publish-node", nodePublishJob(project));
    }
    if (options.docs) {
      addDocsJobs(workflow, project, options.docs);
    }
    workflow.addJob("publish-github-release", githubReleaseJob());
    refreshReleaseDocsDependencies(project);
  }
}
