/** Unified default-branch release workflow generation. */
import { stringUtils } from "@dbx-tools/shared-core";
import { Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import { projectReleaseBranch, type DBXToolsJavaScriptProject } from "./project-js.ts";
import { applyTasks, taskScript } from "./project.ts";
import {
  RELEASE_SHA,
  RELEASE_TAG,
  RELEASE_VERSION,
  releaseSourceSteps,
  type ReleaseSummaryProviderName,
} from "./release-dispatch.ts";

const NODE_VERSION = "24";
const NPM_VERSION = "11.4.2";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const nodeReleaseProjects = new WeakSet<DBXToolsJavaScriptProject>();
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();

/** Independently recoverable portions of the release workflow. */
export type ReleaseStage = "all" | "node" | "python" | "cargo" | "docs";

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

/** Legacy release-summary configuration retained for source compatibility. */
export interface ReleaseSummaryOptions {
  readonly providers?: readonly ReleaseSummaryProviderName[];
}

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /** Git tag prefix. Defaults to `v`. */
  readonly tagPrefix?: string;
  /** Omit normal npm workspace publication while retaining other release jobs. */
  readonly nodeRelease?: boolean;
  /** Build and deploy generated documentation through GitHub Pages. */
  readonly docs?: ReleaseDocsOptions;
  /** Python package root passed to local release preparation. */
  readonly pythonRoot?: string;
  /** Repository task names run after VERSION generation and before candidate construction. */
  readonly validationTasks?: readonly string[];
  /** Include configured Rust/UniFFI release assets in the tag candidate. Defaults to true. */
  readonly nativeRelease?: boolean;
  /** Retained for compatibility; tag releases use GitHub-generated release notes. */
  readonly summary?: boolean | ReleaseSummaryOptions;
}

/** Locate the unified workflow so attached language workspaces can add jobs. */
export function releaseWorkflow(project: DBXToolsJavaScriptProject): GithubWorkflow {
  const workflow = releaseWorkflows.get(project);
  if (!workflow) throw new Error("Release workflow is not configured");
  return workflow;
}

/** Locate the unified workflow when release generation is enabled. */
export function tryReleaseWorkflow(project: DBXToolsJavaScriptProject): GithubWorkflow | undefined {
  return releaseWorkflows.get(project);
}

/** Whether the unified workflow publishes the normal npm workspace. */
export function hasNodeRelease(project: DBXToolsJavaScriptProject): boolean {
  return nodeReleaseProjects.has(project);
}

/** Tag pattern created by release jobs and accepted by manual recovery. */
export function releaseTagPattern(project: DBXToolsJavaScriptProject): string {
  const prefix = releaseTagPrefixes.get(project);
  if (!prefix) throw new Error("Release workflow is not configured");
  return `${prefix}*`;
}

/** Run a release stage after its prerequisite tag-build jobs succeed. */
export function releaseStageCondition(
  _stage: Exclude<ReleaseStage, "all">,
  prerequisites: readonly string[] = [],
): string {
  if (prerequisites.length === 0) return "${{ success() }}";
  return `\${{ always() && ${prerequisites.map((condition) => `(${condition})`).join(" && ")} }}`;
}

/** Publish a release stage after its prerequisite tag-build jobs succeed. */
export function releasePublishCondition(
  _stage: Exclude<ReleaseStage, "all">,
  prerequisites: readonly string[] = [],
): string {
  if (prerequisites.length === 0) return "${{ success() }}";
  return `\${{ always() && ${prerequisites.map((condition) => `(${condition})`).join(" && ")} }}`;
}

/** Shared Bun, Node, cache, and install setup for Node release jobs. */
export function nodeReleaseSetupSteps(project: DBXToolsJavaScriptProject): readonly JobStep[] {
  return [
    ...releaseSourceSteps(),
    ...bunCacheRestoreSteps(project, { ignorePaths: project.workflowCacheIgnorePaths }),
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
    { name: "Install", run: "bun install" },
    bunCacheSaveStep(),
  ];
}

/** Token authentication, GitHub provenance, and dry-run values shared by npm publishers. */
export function npmPublishEnvironment(): Record<string, string> {
  return {
    NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    NPM_CONFIG_PROVENANCE: "true",
    DRY_RUN: "",
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
    permissions: { contents: JobPermission.WRITE },
    timeoutMinutes: 60,
    env: { BUN_VERSION, CI: "true" },
    outputs: {
      release_tag: { stepId: "release", outputName: "release_tag" },
      expected_sha: { stepId: "release", outputName: "expected_sha" },
      release_version: { stepId: "release", outputName: "release_version" },
    },
    steps: [
      {
        name: "Checkout release source",
        uses: "actions/checkout@v6",
        with: {
          ref: "${{ github.ref_name }}",
          "fetch-depth": 0,
        },
      },
      ...bunCacheRestoreSteps(project, { ignorePaths: project.workflowCacheIgnorePaths }),
      { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
      { name: "Install release validation dependencies", run: "bun install --frozen-lockfile" },
      bunCacheSaveStep(),
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
      {
        name: "Build and upload release artifacts",
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_SHA: "${{ steps.release.outputs.expected_sha }}",
          RELEASE_TAG: "${{ steps.release.outputs.release_tag }}",
          RELEASE_VERSION: "${{ steps.release.outputs.release_version }}",
        },
        run: [
          "bun node_modules/@dbx-tools/projen/tasks/release-candidate.ts \\",
          '  --version "$RELEASE_VERSION" \\',
          '  --tag "$RELEASE_TAG" \\',
          '  --sha "$RELEASE_SHA" \\',
          `  --python-root ${JSON.stringify(options.pythonRoot ?? "packages/py")}`.concat(" \\"),
          `  --upload${options.nativeRelease === false ? " --skip-rust" : ""}`,
          'gh release edit "$RELEASE_TAG" --draft=false --latest',
        ].join("\n"),
      },
    ],
  };
}

function nodePublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: releaseStageCondition("node"),
    needs: ["verify-context"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      {
        name: "Download approved npm archives",
        env: { GH_TOKEN: "${{ github.token }}", RELEASE_SHA, RELEASE_TAG, RELEASE_VERSION },
        shell: "bash",
        run: [
          "rm -rf dist/release-download dist/npm-release",
          "mkdir -p dist/release-download",
          'gh release download "$RELEASE_TAG" --pattern release-manifest.json --pattern SHA256SUMS --pattern "*.tgz" --dir dist/release-download',
          "bun node_modules/@dbx-tools/projen/tasks/release-manifest.ts verify \\",
          "  --directory dist/release-download \\",
          '  --tag "$RELEASE_TAG" \\',
          '  --sha "$RELEASE_SHA" \\',
          '  --version "$RELEASE_VERSION" \\',
          "  --kind npm \\",
          "  --output dist/npm-release",
        ].join("\n"),
      },
      {
        name: "Publish approved npm archives",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: 'bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory dist/npm-release --version "$RELEASE_VERSION" $DRY_RUN',
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
    if: releaseStageCondition("docs"),
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
      ...bunCacheRestoreSteps(project, { ignorePaths: project.workflowCacheIgnorePaths }),
      ...options.prepareSteps,
      bunCacheSaveStep(),
      ...options.buildSteps,
      {
        name: "Upload Pages artifact",
        uses: "actions/upload-pages-artifact@v4",
        with: { path: options.artifactPath },
      },
    ],
  });
  workflow.addJob("deploy-docs", {
    if: releasePublishCondition("docs"),
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
}

/** Owns the single release workflow and local release preparation tasks. */
export class DBXToolsRelease extends Component {
  constructor(project: DBXToolsJavaScriptProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    const tagPrefix = options.tagPrefix ?? "v";
    const releaseBranch = projectReleaseBranch(project);
    releaseTagPrefixes.set(project, tagPrefix);
    if (options.nodeRelease !== false) nodeReleaseProjects.add(project);
    applyTasks(project, {
      bump: {
        exec: taskScript(project, "bump.ts", `--prefix ${tagPrefix}`),
        receiveArgs: true,
        description: "Increment VERSION and synchronize generated workspace versions",
      },
      "version:check": {
        exec: taskScript(project, "version-check.ts"),
        description: "Verify every package and generated barrel matches VERSION",
      },
      ...(project.github
        ? {
            release: {
              exec: taskScript(
                project,
                "release-tag.ts",
                `--prefix ${tagPrefix} --branch ${releaseBranch}`,
              ),
              receiveArgs: true,
              description: "Commit the local version bump and push an annotated release tag",
            },
          }
        : {}),
    });
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: {
        group: "release-${{ github.ref_name }}",
        cancelInProgress: false,
      },
    });
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
    releaseWorkflows.set(project, workflow);
  }
}
