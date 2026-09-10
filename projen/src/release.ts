/** Unified default-branch release workflow generation. */
import { Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import { projectReleaseBranch, type DBXToolsJavaScriptProject } from "./project-js.ts";
import { applyTasks, taskScript } from "./project.ts";
import { RELEASE_VERSION, releaseSourceSteps } from "./release-dispatch.ts";

const NODE_VERSION = "lts/*";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const nodeReleaseProjects = new WeakSet<DBXToolsJavaScriptProject>();
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();

/** Independently recoverable portions of the release workflow. */
export type ReleaseStage = "all" | "node" | "python" | "docs";

/** GitHub Pages configuration included in the unified release workflow. */
export interface ReleaseDocsOptions {
  readonly siteUrl: string;
  readonly base?: string;
}

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /** Git tag prefix. Defaults to `v`. */
  readonly tagPrefix?: string;
  /** Omit normal npm workspace publication while retaining other release jobs. */
  readonly nodeRelease?: boolean;
  /** Build and deploy generated documentation through GitHub Pages. */
  readonly docs?: ReleaseDocsOptions;
}

/** Locate the unified workflow so attached language workspaces can add jobs. */
export function releaseWorkflow(project: DBXToolsJavaScriptProject): GithubWorkflow {
  const workflow = releaseWorkflows.get(project);
  if (!workflow) throw new Error("Release workflow is not configured");
  return workflow;
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

/** Run a release stage on default-branch pushes or when selected for manual recovery. */
export function releaseStageCondition(stage: Exclude<ReleaseStage, "all">): string {
  return `\${{ github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == '${stage}' }}`;
}

/** Publish a selected stage unless a manual run remains in dry-run mode. */
export function releasePublishCondition(stage: Exclude<ReleaseStage, "all">): string {
  return `\${{ github.event_name == 'push' || (inputs.dry_run == false && (inputs.stage == 'all' || inputs.stage == '${stage}')) }}`;
}

/** Download release artifacts from this run or a verified earlier run. */
export function releaseArtifactSteps(options: {
  readonly currentName: string;
  readonly recoveredName: string;
  readonly pattern: string;
  readonly path: string;
}): readonly JobStep[] {
  const shared = {
    pattern: options.pattern,
    path: options.path,
    "merge-multiple": true,
  };
  return [
    {
      name: options.currentName,
      if: "${{ inputs.source_run_id == '' }}",
      uses: "actions/download-artifact@v8",
      with: shared,
    },
    {
      name: options.recoveredName,
      if: "${{ inputs.source_run_id != '' }}",
      uses: "actions/download-artifact@v8",
      with: {
        ...shared,
        "run-id": "${{ inputs.source_run_id }}",
        "github-token": "${{ github.token }}",
        repository: "${{ github.repository }}",
      },
    },
  ];
}

/** Shared Bun, Node, cache, and install setup for Node release jobs. */
export function nodeReleaseSetupSteps(project: DBXToolsJavaScriptProject): readonly JobStep[] {
  return [
    ...releaseSourceSteps(),
    ...bunCacheRestoreSteps(project),
    {
      name: "Setup Node.js",
      uses: "actions/setup-node@v6",
      with: { "node-version": NODE_VERSION, "registry-url": NPM_REGISTRY_URL },
    },
    { name: "Install", run: "bun install" },
    bunCacheSaveStep(),
  ];
}

/** Authentication, provenance, and dry-run values shared by npm publishers. */
export function npmPublishEnvironment(): Record<string, string> {
  return {
    NPM_CONFIG_PROVENANCE:
      "${{ (github.event_name == 'push' || inputs.dry_run == false) && 'true' || 'false' }}",
    NPM_CONFIG_TOKEN: "${{ secrets.NPM_TOKEN }}",
    NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    DRY_RUN:
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && '--dry-run' || '' }}",
  };
}

function verifyContextJob(tagPrefix: string, releaseBranch: string): Job {
  return {
    runsOn: ["ubuntu-latest"],
    permissions: { actions: JobPermission.READ, contents: JobPermission.WRITE },
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
          ref: "${{ github.event_name == 'push' && github.sha || inputs.expected_sha }}",
          "fetch-depth": 1,
        },
      },
      {
        name: "Verify release context",
        id: "release",
        shell: "bash",
        env: {
          RELEASE_TAG:
            "${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || '' }}",
          EXPECTED_SHA:
            "${{ github.event_name == 'workflow_dispatch' && inputs.expected_sha || '' }}",
          DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}",
        },
        run: [
          'if [ "$GITHUB_EVENT_NAME" = "push" ]; then',
          '  test "$GITHUB_REF_TYPE" = "branch"',
          `  test "$GITHUB_REF_NAME" = "${releaseBranch}"`,
          '  RELEASE_SHA="$GITHUB_SHA"',
          '  test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
          "  RELEASE_VERSION=\"$(tr -d '\\r\\n' < VERSION)\"",
          '  [[ "$RELEASE_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
          `  RELEASE_TAG="${tagPrefix}$RELEASE_VERSION"`,
          '  if git ls-remote --exit-code --tags origin "refs/tags/$RELEASE_TAG" >/dev/null 2>&1; then',
          '    git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
          '    test "$(git cat-file -t "$RELEASE_TAG")" = "tag"',
          '    test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_SHA"',
          "  else",
          '    git config user.name "github-actions[bot]"',
          '    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
          '    git tag -a "$RELEASE_TAG" "$RELEASE_SHA" -m "$RELEASE_TAG"',
          '    git push origin "refs/tags/$RELEASE_TAG"',
          "  fi",
          "else",
          `  case "$RELEASE_TAG" in ${tagPrefix}*) ;; *) exit 1 ;; esac`,
          '  git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
          '  test "$(git cat-file -t "$RELEASE_TAG")" = "tag"',
          '  RELEASE_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"',
          '  test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
          '  test "$GITHUB_REF_TYPE" = "tag"',
          '  test "$GITHUB_REF_NAME" = "$RELEASE_TAG"',
          '  test "$RELEASE_SHA" = "$EXPECTED_SHA"',
          '  if [ -n "${{ inputs.source_run_id }}" ]; then',
          '    case "${{ inputs.stage }}" in node|python) ;; *) exit 1 ;; esac',
          '    case "${{ inputs.source_run_id }}" in *[!0-9]*|"") exit 1 ;; esac',
          "  fi",
          "fi",
          'echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"',
          'echo "expected_sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"',
          `echo "release_version=\${RELEASE_TAG#${tagPrefix}}" >> "$GITHUB_OUTPUT"`,
        ].join("\n"),
      },
      {
        name: "Verify source artifact run",
        if: "${{ inputs.source_run_id != '' }}",
        uses: "actions/github-script@v8",
        env: {
          EXPECTED_SHA: "${{ steps.release.outputs.expected_sha }}",
          SOURCE_RUN_ID: "${{ inputs.source_run_id }}",
        },
        with: {
          script: [
            "const run = await github.rest.actions.getWorkflowRun({",
            "  owner: context.repo.owner,",
            "  repo: context.repo.repo,",
            "  run_id: Number(process.env.SOURCE_RUN_ID),",
            "});",
            'if (run.data.path !== ".github/workflows/release.yml") core.setFailed("Source run is not release.yml");',
            'if (run.data.head_sha !== process.env.EXPECTED_SHA) core.setFailed("Source run commit does not match the release tag");',
          ].join("\n"),
        },
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
        name: "Compile, package, and publish npm workspace",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: [
          "chmod -R u+w . || true",
          'bun node_modules/@dbx-tools/projen/tasks/publish.ts "$RELEASE_VERSION" $DRY_RUN',
        ].join("\n"),
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
      ...bunCacheRestoreSteps(project),
      {
        name: "Setup Node.js",
        uses: "actions/setup-node@v6",
        with: { "node-version": "22" },
      },
      { name: "Configure Pages", uses: "actions/configure-pages@v5" },
      { name: "Install dependencies", run: "bun install" },
      { name: "Generate docs from READMEs", run: "bun docs/scripts/sync-readmes.mjs" },
      { name: "Install docs dependencies", run: "bun install --cwd .docs-build/site" },
      bunCacheSaveStep(),
      {
        name: "Generate TypeScript API docs",
        run: "bun docs/scripts/generate-api-docs.mjs",
      },
      {
        name: "Check generated titles",
        run: "bun docs/scripts/check-generated-titles.mjs",
      },
      { name: "Build docs", run: "bun run --cwd .docs-build/site build" },
      {
        name: "Check generated links",
        run: "bun run --cwd .docs-build/site check-links",
      },
      {
        name: "Upload Pages artifact",
        uses: "actions/upload-pages-artifact@v4",
        with: { path: ".docs-build/dist" },
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

/** Owns the single release workflow and the local bump task. */
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
        description: "Bump the release version (default patch), then commit and push it",
      },
    });
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: { group: "release", cancelInProgress: false },
    });
    workflow.runName =
      "release ${{ github.event_name == 'push' && github.sha || inputs.release_tag }}";
    workflow.on({
      push: { branches: [releaseBranch] },
      workflowDispatch: {
        inputs: {
          release_tag: {
            description: "Annotated release tag to validate",
            type: "string",
            required: true,
          },
          expected_sha: {
            description: "Commit the release tag must reference",
            type: "string",
            required: true,
          },
          stage: {
            description: "Release stage to build, validate, or recover",
            type: "choice",
            options: ["all", "node", "python", "docs"],
            default: "all",
            required: true,
          },
          source_run_id: {
            description: "Earlier release workflow run containing Rust artifacts",
            type: "string",
            default: "",
            required: false,
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
