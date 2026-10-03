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
import { readWorkspaceVersion } from "./workspace-version.ts";

const NODE_VERSION = "24";
const NPM_VERSION = "11.19.0";
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

/** Optional local AI summary generation during reviewed release preparation. */
export interface ReleaseSummaryOptions {
  /**
   * Provider fallback order.
   *
   * @default ["cursor", "codex", "claude"]
   */
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
  /**
   * Generate a versioned release summary locally. Defaults to enabled with the
   * standard Cursor, Codex, Claude fallback order.
   */
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

/** Run a release stage on promotion or when selected for manual recovery. */
export function releaseStageCondition(
  stage: Exclude<ReleaseStage, "all">,
  prerequisites: readonly string[] = [],
): string {
  if (prerequisites.length === 0) {
    return `\${{ github.event_name == 'release' || inputs.stage == 'all' || inputs.stage == '${stage}' }}`;
  }
  const prefix = prerequisites.length
    ? `always() && ${prerequisites.map((condition) => `(${condition})`).join(" && ")} && `
    : "";
  return `\${{ ${prefix}(github.event_name == 'release' || inputs.stage == 'all' || inputs.stage == '${stage}') }}`;
}

/** Publish a selected stage unless a manual run remains in dry-run mode. */
export function releasePublishCondition(
  stage: Exclude<ReleaseStage, "all">,
  prerequisites: readonly string[] = [],
): string {
  if (prerequisites.length === 0) {
    return `\${{ github.event_name == 'release' || (inputs.dry_run != true && (inputs.stage == 'all' || inputs.stage == '${stage}')) }}`;
  }
  const prefix = prerequisites.length
    ? `always() && ${prerequisites.map((condition) => `(${condition})`).join(" && ")} && `
    : "";
  return `\${{ ${prefix}(github.event_name == 'release' || (inputs.dry_run != true && (inputs.stage == 'all' || inputs.stage == '${stage}'))) }}`;
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
    { name: "Install npm trusted-publishing CLI", run: `npm install --global npm@${NPM_VERSION}` },
    { name: "Install", run: "bun install" },
    bunCacheSaveStep(),
  ];
}

/** Authentication, provenance, and dry-run values shared by npm publishers. */
export function npmPublishEnvironment(): Record<string, string> {
  return {
    NPM_CONFIG_PROVENANCE:
      "${{ (github.event_name == 'release' || inputs.dry_run != true) && 'true' || 'false' }}",
    DRY_RUN:
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && '--dry-run' || '' }}",
  };
}

function verifyContextJob(tagPrefix: string, releaseBranch: string): Job {
  return {
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
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
          ref: "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}",
          "fetch-depth": 0,
        },
      },
      {
        name: "Setup Bun",
        uses: "oven-sh/setup-bun@v2",
        with: { "bun-version": BUN_VERSION },
      },
      { name: "Install release validation dependencies", run: "bun install --frozen-lockfile" },
      {
        name: "Verify release context",
        id: "release",
        shell: "bash",
        env: {
          RELEASE_TAG:
            "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}",
          GH_TOKEN: "${{ github.token }}",
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
          git merge-base --is-ancestor "$RELEASE_SHA" "origin/${releaseBranch}"
          test "$(tr -d '\\r\\n' < VERSION)" = "$RELEASE_VERSION"
          test "$(gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft)" = "false"
          rm -rf dist/release-candidate
          mkdir -p dist/release-candidate
          gh release download "$RELEASE_TAG" --dir dist/release-candidate
          bun node_modules/@dbx-tools/projen/tasks/release-manifest.ts verify \
            --directory dist/release-candidate \
            --tag "$RELEASE_TAG" \
            --sha "$RELEASE_SHA" \
            --version "$RELEASE_VERSION"
          echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"
          echo "expected_sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"
          echo "release_version=$RELEASE_VERSION" >> "$GITHUB_OUTPUT"
        `
          // ============================================================================
        ),
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
    const summary = options.summary ?? true;
    const summaryArgs =
      summary === false || (typeof summary === "object" && summary.providers?.length === 0)
        ? ["--no-release-summary"]
        : typeof summary === "object" && summary.providers
          ? [`--release-summary-providers ${summary.providers.join(",")}`]
          : [];
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
                "release-pr.ts",
                [
                  `--prefix ${tagPrefix}`,
                  `--base ${releaseBranch}`,
                  ...(options.pythonRoot
                    ? [`--python-root ${JSON.stringify(options.pythonRoot)}`]
                    : []),
                  ...(options.validationTasks ?? []).map(
                    (task) => `--validate-task ${JSON.stringify(task)}`,
                  ),
                  ...summaryArgs,
                ].join(" "),
              ),
              receiveArgs: true,
              description:
                "Prepare, validate, locally publish, and upload a draft release candidate",
            },
            "release:assets": {
              exec: taskScript(project, "release-candidate.ts"),
              receiveArgs: true,
              description: "Rebuild and upload a complete draft release candidate",
            },
          }
        : {}),
    });
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: {
        group:
          "release-${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}",
        cancelInProgress: false,
      },
    });
    const version = readWorkspaceVersion(project.outdir);
    workflow.runName =
      `release ${version} ` +
      "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}";
    workflow.on({
      release: { types: ["published"] },
      workflowDispatch: {
        inputs: {
          release_tag: {
            description: "Annotated release tag to validate",
            type: "string",
            required: true,
          },
          stage: {
            description: "Published release stage to validate or recover",
            type: "choice",
            options: ["all", "node", "python", "cargo", "docs"],
            default: "all",
            required: true,
          },
          dry_run: {
            description: "Build and validate without publishing",
            type: "boolean",
            default: "true",
            required: true,
          },
        },
      },
    });
    workflow.file?.addOverride("permissions.contents", "read");
    workflow.file?.addOverride("on.workflow_dispatch.inputs.dry_run.default", true);
    workflow.addJob("verify-context", verifyContextJob(tagPrefix, releaseBranch));
    if (options.nodeRelease !== false) {
      workflow.addJob("publish-node", nodePublishJob(project));
    }
    if (options.docs) {
      addDocsJobs(workflow, project, options.docs);
    }
    releaseWorkflows.set(project, workflow);
  }
}
