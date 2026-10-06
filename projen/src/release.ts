/**
 * Unified annotated-tag release workflow generation.
 *
 * Projen's native `Release` owns a different lifecycle: it calculates versions
 * from commits, generates changelogs and GitHub Releases, and publishes Publib's
 * ecosystem-specific artifact tree from branch workflows. This repository
 * instead creates one reviewed `VERSION` commit and annotated `v*` tag locally,
 * requires that tag to equal `origin/main`, omits GitHub Releases, and builds
 * npm, Python, and documentation artifacts once before isolated publication
 * jobs download them. `DBXToolsRelease` therefore remains separate while native
 * workflow and project primitives own the YAML model and setup steps.
 */
import { stringUtils } from "@dbx-tools/shared-core";
import { Component, github } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION } from "./bun-workflow.ts";
import { projectReleaseBranch, taskCommand, type DBXToolsJavaScriptProject } from "./project-js.ts";
import { RELEASE_VERSION } from "./release-context.ts";
import type { ReleaseStepSelection } from "./release-options.ts";

const NODE_VERSION = "24";
const NPM_VERSION = "11.4.2";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();

/** GitHub Pages configuration included in the unified release workflow. */
export interface ReleaseDocsOptions {
  readonly siteUrl: string;
  readonly base?: string;
  /** Documentation generation steps run in the shared release build after validation. */
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
  /** Repository prerequisites installed before release validation and artifact builds. */
  readonly setupSteps?: readonly JobStep[];
  /** Repository-specific synthesis commands run before the root Projen synthesis check. */
  readonly synthesisCommands?: readonly string[];
}

/** Locate the unified workflow when release generation is enabled. */
export function tryReleaseWorkflow(project: DBXToolsJavaScriptProject): GithubWorkflow | undefined {
  return releaseWorkflows.get(project);
}

/** Tag pattern accepted by the unified release workflow. */
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

/** Gate shared-build steps using the same per-run flag, preserving their existing conditions. */
export function releaseBuildSteps(
  flag: keyof ReleaseStepSelection,
  steps: readonly JobStep[],
): JobStep[] {
  return steps.map((step) => ({
    ...step,
    if: `\${{ success() && steps.release.outputs.${flag} == 'true'${step.if ? ` && (${step.if.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")})` : ""} }}`,
  }));
}

/** Artifact-only publication runtime and npm authentication; no workspace installation. */
export function nodeReleaseSetupSteps(): readonly JobStep[] {
  return [
    {
      name: "Setup Bun",
      uses: github.ActionRefs.OVEN_SH_SETUP_BUN,
      with: { "bun-version": BUN_VERSION },
    },
    {
      name: "Setup Node.js",
      uses: github.ActionRefs.ACTIONS_SETUP_NODE,
      with: {
        "node-version": NODE_VERSION,
        "registry-url": NPM_REGISTRY_URL,
        "package-manager-cache": false,
      },
    },
    { name: "Install npm CLI", run: `npm install --global npm@${NPM_VERSION}` },
  ];
}

/** Install uv for Python release builds. */
export function uvSetupStep(): JobStep {
  return {
    name: "Setup uv",
    uses: "astral-sh/setup-uv@v7",
  };
}

function refreshDocsRegistryDependencies(workflow: GithubWorkflow): void {
  const docs = workflow.getJob("deploy-docs") as Job | undefined;
  if (!docs) return;
  const registryJobs = Object.keys(workflow.jobs).filter(
    (name) => name === "publish-node" || name.startsWith("publish-pypi-"),
  );
  if (registryJobs.length > 0) {
    workflow.updateJob("deploy-docs", {
      ...docs,
      needs: ["build-release", ...registryJobs],
      if: releaseCondition([
        "needs['build-release'].result == 'success'",
        "needs['build-release'].outputs.docs == 'true'",
        ...registryJobs.map(
          (name) => `needs['${name}'].result == 'success' || needs['${name}'].result == 'skipped'`,
        ),
      ]),
    });
  }
}

/** Keep documentation publication behind every configured package registry. */
export function refreshReleaseDocsDependencies(project: DBXToolsJavaScriptProject): void {
  const workflow = releaseWorkflows.get(project);
  if (workflow) {
    refreshDocsRegistryDependencies(workflow);
  }
}

function releaseBuildJob(
  project: DBXToolsJavaScriptProject,
  tagPrefix: string,
  releaseBranch: string,
  options: DBXToolsReleaseOptions,
): Job {
  return {
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    timeoutMinutes: 60,
    env: {
      CI: "true",
      ...(options.docs
        ? { DOCS_SITE_URL: options.docs.siteUrl, DOCS_BASE: options.docs.base ?? "/" }
        : {}),
    },
    outputs: {
      release_tag: { stepId: "release", outputName: "release_tag" },
      expected_sha: { stepId: "release", outputName: "expected_sha" },
      release_version: { stepId: "release", outputName: "release_version" },
      npm: { stepId: "release", outputName: "npm" },
      pypi: { stepId: "release", outputName: "pypi" },
      docs: { stepId: "release", outputName: "docs" },
    },
    steps: [
      github.WorkflowSteps.checkout({
        name: "Checkout release source",
        with: {
          ref: "${{ github.ref_name }}",
          fetchDepth: 0,
        },
      }),
      ...project.renderWorkflowSetup({ mutable: true }),
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
          bun node_modules/@dbx-tools/projen/tasks/release-options.ts --tag "$RELEASE_TAG" --output "$GITHUB_OUTPUT"
        `
          // ============================================================================
        ),
      },
      {
        name: "Verify generated sources",
        run: [
          ...(options.synthesisCommands ?? []),
          "bunx projen",
          "git diff --ignore-space-at-eol --exit-code",
        ].join("\n"),
      },
      { name: "Verify workspace versions", run: "bun run version:check" },
      ...(options.setupSteps ?? []),
      ...releaseBuildSteps(
        "validation",
        (options.validationTasks ?? []).map((task) => ({
          name: `Validate ${task}`,
          run: `bun run ${task}`,
        })),
      ),
      ...(options.nodeRelease === false
        ? []
        : releaseBuildSteps("npm", [
            {
              name: "Build npm archives",
              env: { RELEASE_VERSION: "${{ steps.release.outputs.release_version }}" },
              run: [
                "bun run compile",
                'bun node_modules/@dbx-tools/projen/tasks/publish.ts "$RELEASE_VERSION" --skip-compile --output .release/npm',
                "bun build node_modules/@dbx-tools/projen/tasks/publish-npm.ts --target=bun --outfile=.release/npm/publish-npm.mjs",
              ].join("\n"),
            },
            {
              name: "Upload npm archives",
              uses: github.ActionRefs.ACTIONS_UPLOAD_ARTIFACT,
              with: { name: "release-npm", path: ".release/npm", "if-no-files-found": "error" },
            },
          ])),
      ...(options.docs
        ? releaseBuildSteps("docs", [
            ...options.docs.prepareSteps,
            ...options.docs.buildSteps,
            {
              name: "Upload Pages artifact",
              uses: "actions/upload-pages-artifact@v4",
              with: { path: options.docs.artifactPath },
            },
          ])
        : []),
    ],
  };
}

function nodePublishJob(): Job {
  return {
    if: releaseCondition([
      "needs['build-release'].result == 'success'",
      "needs['build-release'].outputs.npm == 'true'",
    ]),
    needs: ["build-release"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { CI: "true" },
    steps: [
      {
        name: "Download npm archives",
        uses: github.ActionRefs.ACTIONS_DOWNLOAD_ARTIFACT,
        with: { name: "release-npm", path: ".release/npm" },
      },
      ...nodeReleaseSetupSteps(),
      {
        name: "Publish npm workspace",
        env: {
          RELEASE_VERSION,
          NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
          NPM_CONFIG_PROVENANCE: "true",
        },
        run: 'bun .release/npm/publish-npm.mjs --directory .release/npm --version "$RELEASE_VERSION"',
      },
    ],
  };
}

function addDocsJobs(workflow: GithubWorkflow): void {
  workflow.addJob("deploy-docs", {
    if: releaseCondition([
      "needs['build-release'].result == 'success'",
      "needs['build-release'].outputs.docs == 'true'",
    ]),
    needs: ["build-release"],
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
    project.addGitIgnore(".release/");
    const installCondition =
      "bun -e \"process.exit(process.env.DBX_TOOLS_RELEASE_INSTALL === 'never' ? 1 : 0)\"";
    project.package.installTask.addCondition(installCondition);
    project.package.installCiTask.addCondition(installCondition);
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
    workflow.addJob("build-release", releaseBuildJob(project, tagPrefix, releaseBranch, options));
    if (options.nodeRelease !== false) {
      workflow.addJob("publish-node", nodePublishJob());
    }
    if (options.docs) {
      addDocsJobs(workflow);
    }
    refreshReleaseDocsDependencies(project);
  }
}
