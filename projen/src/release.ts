/** Unified tag-driven release workflow generation. */
import { Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import type { DBXToolsJavaScriptProject } from "./project-js.ts";
import { applyTasks, taskScript } from "./project.ts";
import { RELEASE_VERSION, releaseSourceSteps } from "./release-dispatch.ts";

const NODE_VERSION = "lts/*";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const nodeReleaseProjects = new WeakSet<DBXToolsJavaScriptProject>();
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();

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

/** Tag pattern accepted by release jobs and GitHub environments. */
export function releaseTagPattern(project: DBXToolsJavaScriptProject): string {
  const prefix = releaseTagPrefixes.get(project);
  if (!prefix) throw new Error("Release workflow is not configured");
  return `${prefix}*`;
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
    NPM_CONFIG_PROVENANCE: "${{ github.event_name == 'push' && 'true' || 'false' }}",
    NPM_CONFIG_TOKEN: "${{ secrets.NPM_TOKEN }}",
    NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && '--dry-run' || '' }}",
  };
}

function verifyContextJob(tagPrefix: string): Job {
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
        name: "Checkout release tag",
        uses: "actions/checkout@v6",
        with: {
          ref: "${{ github.event_name == 'push' && github.ref || inputs.expected_sha }}",
          "fetch-depth": 1,
        },
      },
      {
        name: "Verify release context",
        id: "release",
        shell: "bash",
        env: {
          RELEASE_TAG:
            "${{ github.event_name == 'push' && github.ref_name || inputs.release_tag }}",
          EXPECTED_SHA:
            "${{ github.event_name == 'workflow_dispatch' && inputs.expected_sha || '' }}",
          DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}",
        },
        run: [
          `case "$RELEASE_TAG" in ${tagPrefix}*) ;; *) exit 1 ;; esac`,
          'git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
          'test "$(git cat-file -t "$RELEASE_TAG")" = "tag"',
          'RELEASE_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"',
          'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
          'if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then',
          '  test "$DRY_RUN" = "true"',
          '  test "$RELEASE_SHA" = "$EXPECTED_SHA"',
          "fi",
          'echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"',
          'echo "expected_sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"',
          `echo "release_version=\${RELEASE_TAG#${tagPrefix}}" >> "$GITHUB_OUTPUT"`,
        ].join("\n"),
      },
    ],
  };
}

function nodePublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
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
      {
        name: "Check generated titles",
        run: "bun docs/scripts/check-generated-titles.mjs",
      },
      { name: "Install docs dependencies", run: "bun install --cwd .docs-build/site" },
      bunCacheSaveStep(),
      {
        name: "Generate TypeScript API docs",
        run: "bun docs/scripts/generate-api-docs.mjs",
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
    if: "${{ github.event_name == 'push' }}",
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
    releaseTagPrefixes.set(project, tagPrefix);
    if (options.nodeRelease !== false) nodeReleaseProjects.add(project);
    applyTasks(project, {
      bump: {
        exec: taskScript(project, "bump.ts", `--prefix ${tagPrefix}`),
        receiveArgs: true,
        description: "Bump the release version (default patch), then commit, tag, and push it",
      },
    });
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: { group: "release", cancelInProgress: true },
    });
    workflow.runName =
      "release ${{ github.event_name == 'push' && github.ref_name || inputs.release_tag }}";
    workflow.on({
      push: { tags: [`${tagPrefix}*`] },
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
    workflow.addJob("verify-context", verifyContextJob(tagPrefix));
    if (options.nodeRelease !== false) {
      workflow.addJob("publish-node", nodePublishJob(project));
    }
    if (options.docs) {
      addDocsJobs(workflow, project, options.docs);
    }
    releaseWorkflows.set(project, workflow);
  }
}
