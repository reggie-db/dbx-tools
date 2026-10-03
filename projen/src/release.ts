/** Unified default-branch release workflow generation. */
import { stringUtils } from "@dbx-tools/shared-core";
import { Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import { projectReleaseBranch, type DBXToolsJavaScriptProject } from "./project-js.ts";
import { applyTasks, taskScript } from "./project.ts";
import {
  RELEASE_VERSION,
  releaseSourceSteps,
  type ReleaseSummaryProviderName,
} from "./release-dispatch.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

const NODE_VERSION = "lts/*";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const nodeReleaseProjects = new WeakSet<DBXToolsJavaScriptProject>();
const releaseTagPrefixes = new WeakMap<DBXToolsJavaScriptProject, string>();
const releaseWorkflows = new WeakMap<DBXToolsJavaScriptProject, GithubWorkflow>();
const independentPublicationJobs = new WeakMap<GithubWorkflow, Set<string>>();

/** Independently recoverable portions of the release workflow. */
export type ReleaseStage = "all" | "node" | "python" | "docs";

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
  /** Repository task names run in the release worktree before expensive validation and publication. */
  readonly validationTasks?: readonly string[];
  /**
   * Existing source branch safely fast-forwarded after publication.
   *
   * Missing or diverged branches are left untouched.
   */
  readonly syncBranch?: string | false;
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

/** Register one publication job for the independent release completion barrier. */
export function registerIndependentPublicationJob(workflow: GithubWorkflow, jobId: string): void {
  const jobs = independentPublicationJobs.get(workflow) ?? new Set<string>();
  jobs.add(jobId);
  independentPublicationJobs.set(workflow, jobs);
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
  readonly condition?: string;
}): readonly JobStep[] {
  const shared = {
    pattern: options.pattern,
    path: options.path,
    "merge-multiple": true,
  };
  return [
    {
      name: options.currentName,
      if: `\${{ ${options.condition ? `${options.condition} && ` : ""}inputs.source_run_id == '' }}`,
      uses: "actions/download-artifact@v8",
      with: shared,
    },
    {
      name: options.recoveredName,
      if: `\${{ ${options.condition ? `${options.condition} && ` : ""}inputs.source_run_id != '' }}`,
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
    ...bunCacheRestoreSteps(project, { ignorePaths: project.workflowCacheIgnorePaths }),
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
      build_mode: { stepId: "release", outputName: "build_mode" },
    },
    steps: [
      {
        name: "Checkout release source",
        uses: "actions/checkout@v6",
        with: {
          ref: "${{ github.event_name == 'push' && github.sha || inputs.expected_sha }}",
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
            "${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || '' }}",
          EXPECTED_SHA:
            "${{ github.event_name == 'workflow_dispatch' && inputs.expected_sha || '' }}",
          DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}",
          GH_TOKEN: "${{ github.token }}",
        },
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          if [ "$GITHUB_EVENT_NAME" = "push" ]; then
            test "$GITHUB_REF_TYPE" = "branch"
            test "$GITHUB_REF_NAME" = "${releaseBranch}"
            RELEASE_SHA="$GITHUB_SHA"
            test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
            RELEASE_VERSION="$(tr -d '\\r\\n' < VERSION)"
            bun node_modules/@dbx-tools/projen/tasks/release-version.ts --version "$RELEASE_VERSION"
            PREVIOUS_VERSION="$(git show "$RELEASE_SHA^:VERSION" | tr -d '\\r\\n')"
            test "$PREVIOUS_VERSION" != "$RELEASE_VERSION"
            RELEASE_TAG="${tagPrefix}$RELEASE_VERSION"
            if git ls-remote --exit-code --tags origin "refs/tags/$RELEASE_TAG" >/dev/null 2>&1; then
              git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
              test "$(git cat-file -t "$RELEASE_TAG")" = "tag"
              test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_SHA"
            else
              git fetch --force --tags origin
              bun node_modules/@dbx-tools/projen/tasks/release-version.ts --version "$RELEASE_VERSION" --prefix ${JSON.stringify(tagPrefix)} --assert-next
              git config user.name "github-actions[bot]"
              git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
              git tag -a "$RELEASE_TAG" "$RELEASE_SHA" -m "$RELEASE_TAG"
              git push origin "refs/tags/$RELEASE_TAG"
            fi
          else
            case "$RELEASE_TAG" in ${tagPrefix}*) ;; *) exit 1 ;; esac
            RELEASE_VERSION="\${RELEASE_TAG#${tagPrefix}}"
            bun node_modules/@dbx-tools/projen/tasks/release-version.ts --version "$RELEASE_VERSION"
            git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
            test "$(git cat-file -t "$RELEASE_TAG")" = "tag"
            RELEASE_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"
            test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
            test "$RELEASE_SHA" = "$EXPECTED_SHA"
            if [ -n "\${{ inputs.source_run_id }}" ]; then
              case "\${{ inputs.stage }}" in node|python) ;; *) exit 1 ;; esac
              case "\${{ inputs.source_run_id }}" in *[!0-9]*|"") exit 1 ;; esac
            fi
          fi
          BUILD_MODE="$(git log -1 --format=%B -- VERSION | sed -n 's/^Release-Build: //p' | tail -1)"
          case "$BUILD_MODE" in local|remote) ;; *) BUILD_MODE="remote" ;; esac
          if [ "$BUILD_MODE" = "local" ] && ! gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
            gh release create "$RELEASE_TAG" --draft --title "$RELEASE_TAG" --target "$RELEASE_SHA"
          fi
          echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"
          echo "expected_sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"
          echo "release_version=$RELEASE_VERSION" >> "$GITHUB_OUTPUT"
          echo "build_mode=$BUILD_MODE" >> "$GITHUB_OUTPUT"
        `
          // ============================================================================
        ),
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
          // prettier-ignore
          script: stringUtils.dedent(
            // ============================================================================
            /*js*/`
            const run = await github.rest.actions.getWorkflowRun({
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: Number(process.env.SOURCE_RUN_ID),
            });
            if (run.data.path !== ".github/workflows/release.yml") core.setFailed("Source run is not release.yml");
            if (run.data.head_sha !== process.env.EXPECTED_SHA) core.setFailed("Source run commit does not match the release tag");
          `
            // ============================================================================
          ),
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

function independentReleasePleaseJob(project: DBXToolsJavaScriptProject, branch: string): Job {
  return {
    if: "${{ github.event_name == 'push' || inputs.automatic == true }}",
    runsOn: ["ubuntu-latest"],
    permissions: {
      actions: JobPermission.WRITE,
      contents: JobPermission.WRITE,
      pullRequests: JobPermission.WRITE,
    },
    timeoutMinutes: 30,
    env: { BUN_VERSION },
    outputs: {
      releases_created: { stepId: "release", outputName: "releases_created" },
      prs_created: { stepId: "release", outputName: "prs_created" },
      releases: { stepId: "release", outputName: "releases" },
      prs: { stepId: "release", outputName: "prs" },
      docs_changed: { stepId: "changes", outputName: "docs_changed" },
      recovery_requested: { stepId: "recovery", outputName: "requested" },
      recovery_component: { stepId: "recovery", outputName: "component" },
      recovery_version: { stepId: "recovery", outputName: "version" },
    },
    steps: [
      {
        name: "Checkout source",
        uses: "actions/checkout@v6",
        with: { "fetch-depth": 2 },
      },
      ...bunCacheRestoreSteps(project, {
        ignorePaths: project.workflowCacheIgnorePaths,
      }),
      { name: "Install dependencies", run: "bun install" },
      {
        name: "Refresh Release Please state",
        id: "release",
        env: { GITHUB_TOKEN: "${{ github.token }}" },
        run: [
          'OWNER="${GITHUB_REPOSITORY%%/*}"',
          'REPO="${GITHUB_REPOSITORY#*/}"',
          `bun node_modules/@dbx-tools/projen/tasks/release-please.ts --owner "$OWNER" --repo "$REPO" --target-branch ${JSON.stringify(branch)}`,
        ].join("\n"),
      },
      {
        name: "Detect documentation changes",
        id: "changes",
        shell: "bash",
        run: [
          "if git diff --quiet HEAD^ HEAD -- README.md AGENTS.md ':(glob)**/README.md' docs ':(exclude)docs/releases/**' ':(exclude).release-notes/**'; then",
          '  echo "docs_changed=false" >> "$GITHUB_OUTPUT"',
          "else",
          '  echo "docs_changed=true" >> "$GITHUB_OUTPUT"',
          "fi",
        ].join("\n"),
      },
      {
        name: "Detect committed recovery request",
        id: "recovery",
        shell: "bash",
        run: [
          "if [ -f .release-recovery.json ]; then",
          '  echo "requested=true" >> "$GITHUB_OUTPUT"',
          '  echo "component=$(jq -r .component .release-recovery.json)" >> "$GITHUB_OUTPUT"',
          '  echo "version=$(jq -r .version .release-recovery.json)" >> "$GITHUB_OUTPUT"',
          "else",
          '  echo "requested=false" >> "$GITHUB_OUTPUT"',
          "fi",
        ].join("\n"),
      },
      {
        name: "Reconcile generated release PR files",
        if: "${{ steps.release.outputs.prs_created == 'true' }}",
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_BRANCH: branch,
          RELEASE_PRS: "${{ steps.release.outputs.prs }}",
        },
        shell: "bash",
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          BRANCH="$(jq -r '.[0].headBranchName' <<<"$RELEASE_PRS")"
          test -n "$BRANCH" && test "$BRANCH" != "null"
          git fetch origin "$BRANCH"
          git switch --force-create "$BRANCH" "origin/$BRANCH"
          bun install
          bunx projen
          bun node_modules/@dbx-tools/projen/tasks/version-check.ts
          bun node_modules/@dbx-tools/projen/tasks/release-plan.ts --base-ref origin/${branch}
          bun node_modules/@dbx-tools/projen/tasks/release-summary-units.ts --from-ref origin/${branch}
          if ! git diff --quiet || test -n "$(git ls-files --others --exclude-standard)"; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git add -A
            git commit -m "chore: reconcile release metadata"
            git push origin "HEAD:$BRANCH"
          fi
          MERGED="false"
          for ATTEMPT in $(seq 1 15); do
            STATE="$(gh pr view "$BRANCH" --json state,mergeable --jq '[.state,.mergeable] | join(" ")')"
            if [[ "$STATE" == MERGED* ]]; then MERGED="true"; break; fi
            if [ "$STATE" = "OPEN CONFLICTING" ]; then
              echo "::error::release pull request has merge conflicts"
              exit 1
            fi
            if [ "$STATE" = "OPEN MERGEABLE" ] && gh pr merge "$BRANCH" --merge; then
              MERGED="true"
              break
            fi
            echo "release pull request is not mergeable yet (attempt $ATTEMPT/15)"
            sleep 2
          done
          if [ "$MERGED" != "true" ]; then
            echo "::error::release pull request did not become mergeable"
            exit 1
          fi
          gh workflow run release.yml --ref "$RELEASE_BRANCH" -f automatic=true
        `
          // ============================================================================
        ),
      },
    ],
  };
}

function configureReleaseRequestWorkflow(
  project: DBXToolsJavaScriptProject,
  baseBranch: string,
): void {
  if (!project.github) return;
  const workflow = new GithubWorkflow(project.github, "release-request", {
    fileName: "release-request.yml",
    limitConcurrency: true,
    concurrencyOptions: {
      group: "release-request-${{ github.ref_name }}",
      cancelInProgress: false,
    },
  });
  workflow.runName = "release request ${{ github.ref_name }}";
  workflow.on({ push: {} });
  workflow.file?.addOverride("permissions.contents", "read");
  workflow.addJob("request", {
    if: `\${{ github.ref_name != '${baseBranch}' }}`,
    runsOn: ["ubuntu-latest"],
    permissions: {
      actions: JobPermission.WRITE,
      contents: JobPermission.WRITE,
      pullRequests: JobPermission.WRITE,
    },
    steps: [
      {
        name: "Checkout source branch",
        uses: "actions/checkout@v6",
        with: { "fetch-depth": 2 },
      },
      {
        name: "Read release request",
        id: "request",
        shell: "bash",
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          MESSAGE="$(git log -1 --format=%B)"
          if ! grep -q "^Release-Request: true$" <<<"$MESSAGE"; then
            echo "requested=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          git fetch origin ${JSON.stringify(baseBranch)}
          if git diff --quiet "origin/${baseBranch}...HEAD"; then
            echo "requested=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "requested=true" >> "$GITHUB_OUTPUT"
          echo "branch=$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
          echo "notes_path=$(sed -n 's/^Release-Notes-Path: //p' <<<"$MESSAGE" | tail -1)" >> "$GITHUB_OUTPUT"
          echo "title=$(git log -1 --skip=1 --format=%s)" >> "$GITHUB_OUTPUT"
        `
          // ============================================================================
        ),
      },
      {
        name: "Create, merge, and release source pull request",
        if: "${{ steps.request.outputs.requested == 'true' }}",
        env: {
          GH_TOKEN: "${{ github.token }}",
          SOURCE_BRANCH: "${{ steps.request.outputs.branch }}",
          BASE_BRANCH: baseBranch,
          TITLE: "${{ steps.request.outputs.title }}",
          NOTES_PATH: "${{ steps.request.outputs.notes_path }}",
        },
        shell: "bash",
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          test -f "$NOTES_PATH"
          NOTES="$(cat "$NOTES_PATH")"
          BODY="$(printf '## Release notes\\n\\n%s\\n' "$NOTES")"
          PR="$(gh pr list --head "$SOURCE_BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty')"
          if [ -n "$PR" ]; then
            gh pr edit "$PR" --title "$TITLE" --body "$BODY"
          else
            gh pr create --head "$SOURCE_BRANCH" --base "$BASE_BRANCH" --title "$TITLE" --body "$BODY"
            PR="$(gh pr list --head "$SOURCE_BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number')"
          fi
          gh pr merge "$PR" --merge
          gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$BASE_BRANCH" -f automatic=true
        `
          // ============================================================================
        ),
      },
    ],
  });
}

function independentReleasePlanJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ always() && ((github.event_name == 'workflow_dispatch' && inputs.automatic != true) || needs.release-please.outputs.releases_created == 'true' || (needs.release-please.outputs.docs_changed == 'true' && needs.release-please.outputs.prs_created != 'true') || needs.release-please.outputs.recovery_requested == 'true') }}",
    needs: ["release-please"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    timeoutMinutes: 15,
    env: { BUN_VERSION },
    outputs: {
      release_sha: { stepId: "plan", outputName: "release_sha" },
      rust: { stepId: "plan", outputName: "rust" },
      python: { stepId: "plan", outputName: "python" },
      node: { stepId: "plan", outputName: "node" },
      github: { stepId: "plan", outputName: "github" },
      docs: { stepId: "plan", outputName: "docs" },
      units: { stepId: "plan", outputName: "units" },
      python_packages: { stepId: "plan", outputName: "python_packages" },
      rust_packages: { stepId: "plan", outputName: "rust_packages" },
      artifacts: { stepId: "plan", outputName: "artifacts" },
      rust_targets: { stepId: "plan", outputName: "rust_targets" },
    },
    steps: [
      {
        name: "Checkout release source",
        uses: "actions/checkout@v6",
        with: { "fetch-depth": 2 },
      },
      ...bunCacheRestoreSteps(project, {
        ignorePaths: project.workflowCacheIgnorePaths,
      }),
      { name: "Install dependencies", run: "bun install" },
      {
        name: "Build affected release plan",
        id: "plan",
        shell: "bash",
        env: {
          COMPONENT:
            "${{ inputs.component || needs.release-please.outputs.recovery_component || '' }}",
          VERSION: "${{ inputs.version || needs.release-please.outputs.recovery_version || '' }}",
          DOCS_CHANGED: "${{ needs.release-please.outputs.docs_changed || 'false' }}",
        },
        run: [
          "ARGS=()",
          'if [ -n "$COMPONENT" ]; then ARGS+=(--component "$COMPONENT" --version "$VERSION"); fi',
          'if [ "$DOCS_CHANGED" = "true" ]; then ARGS+=(--docs); fi',
          'bun node_modules/@dbx-tools/projen/tasks/release-plan.ts "${ARGS[@]}"',
        ].join("\n"),
      },
      {
        name: "Upload release plan",
        uses: "actions/upload-artifact@v7",
        with: {
          name: "release-plan",
          path: "dist/release-plan.json",
          "if-no-files-found": "error",
        },
      },
    ],
  };
}

/** Checkout and install the immutable source selected by an independent release plan. */
export function independentReleaseSetupSteps(
  project: DBXToolsJavaScriptProject,
): readonly JobStep[] {
  return [
    {
      name: "Checkout release source",
      uses: "actions/checkout@v6",
      with: { ref: "${{ needs.release-plan.outputs.release_sha }}", "fetch-depth": 1 },
    },
    ...bunCacheRestoreSteps(project, {
      ignorePaths: project.workflowCacheIgnorePaths,
    }),
    { name: "Install dependencies", run: "bun install" },
    {
      name: "Download release plan",
      uses: "actions/download-artifact@v8",
      with: { name: "release-plan", path: "dist" },
    },
  ];
}

function independentNodePublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ needs.release-plan.outputs.node == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["release-plan"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 60,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Publish affected npm packages",
        env: npmPublishEnvironment(),
        run: "bun node_modules/@dbx-tools/projen/tasks/publish.ts --plan dist/release-plan.json",
      },
    ],
  };
}

function independentReleaseNotesJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ needs.release-plan.outputs.units != '[]' }}",
    needs: ["release-plan"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    env: { BUN_VERSION },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Publish component release notes",
        env: { GH_TOKEN: "${{ github.token }}" },
        shell: "bash",
        run: [
          "jq -c '.units[]' dist/release-plan.json | while read -r UNIT; do",
          '  COMPONENT="$(jq -r .component <<<"$UNIT")"',
          '  VERSION="$(jq -r .newVersion <<<"$UNIT")"',
          '  gh release edit "$COMPONENT-v$VERSION" --notes-file ".release-notes/final/$COMPONENT-v$VERSION.md"',
          "done",
        ].join("\n"),
      },
      {
        name: "Remove consumed release notes",
        shell: "bash",
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          git fetch origin ${JSON.stringify(projectReleaseBranch(project))}
          if [ "$(git rev-parse origin/${projectReleaseBranch(project)})" != "$(git rev-parse HEAD)" ]; then
            echo "::warning::main advanced before release-note cleanup; leaving temporary notes for the next release"
            exit 0
          fi
          git rm -r --ignore-unmatch .release-notes
          if ! git diff --cached --quiet; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git commit -m "chore: remove consumed release notes"
            git push origin "HEAD:${projectReleaseBranch(project)}"
          fi
        `
          // ============================================================================
        ),
      },
    ],
  };
}

function addIndependentDocsJobs(
  workflow: GithubWorkflow,
  project: DBXToolsJavaScriptProject,
  options: ReleaseDocsOptions,
): void {
  workflow.addJob("build-docs", {
    if: "${{ always() && needs['release-plan'].outputs.docs == 'true' && needs['publication-complete'].result == 'success' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'docs') }}",
    needs: ["release-plan", "publication-complete"],
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
      ...independentReleaseSetupSteps(project),
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
    if: "${{ always() && needs['build-docs'].result == 'success' }}",
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

function addIndependentBranchSyncJob(
  workflow: GithubWorkflow,
  project: DBXToolsJavaScriptProject,
  branch: string,
): void {
  const releaseBranch = projectReleaseBranch(project);
  workflow.addJob("sync-release-branch", {
    if: "${{ always() && (github.event_name == 'push' || inputs.automatic == true) && needs['publication-complete'].result == 'success' }}",
    needs: ["publication-complete"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    env: { BUN_VERSION },
    steps: [
      {
        name: "Checkout released main",
        uses: "actions/checkout@v6",
        with: { "fetch-depth": 0 },
      },
      ...bunCacheRestoreSteps(project, {
        ignorePaths: project.workflowCacheIgnorePaths,
      }),
      { name: "Install dependencies", run: "bun install" },
      {
        name: `Safely sync ${branch}`,
        shell: "bash",
        env: { SOURCE_BRANCH: branch, RELEASE_BRANCH: releaseBranch },
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
          if ! git ls-remote --exit-code --heads origin "refs/heads/$SOURCE_BRANCH" >/dev/null 2>&1; then
            echo "source branch $SOURCE_BRANCH no longer exists; nothing to sync"
            exit 0
          fi
          git fetch origin "refs/heads/$SOURCE_BRANCH:refs/remotes/origin/$SOURCE_BRANCH"
          git fetch origin "refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH"
          if git merge-base --is-ancestor "origin/$SOURCE_BRANCH" "origin/$RELEASE_BRANCH"; then
            git push origin "refs/remotes/origin/$RELEASE_BRANCH:refs/heads/$SOURCE_BRANCH"
          elif git merge-base --is-ancestor "origin/$RELEASE_BRANCH" "origin/$SOURCE_BRANCH"; then
            echo "source branch $SOURCE_BRANCH already contains released main"
          else
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git switch --force-create "$SOURCE_BRANCH" "origin/$SOURCE_BRANCH"
            if git merge --no-ff --no-edit "origin/$RELEASE_BRANCH"; then
              git push origin "HEAD:refs/heads/$SOURCE_BRANCH"
            else
              SAFE_GENERATED="true"
              while IFS= read -r FILE; do
                case "$FILE" in
                  .projen/release-units.json|.release-please-manifest.json|.release-units/*/source.json|.release-units/*/version.txt|.release-units/*/CHANGELOG.md|Cargo.lock|*/Cargo.toml|*/package.json|*/pyproject.toml|*/index.ts) ;;
                  *) SAFE_GENERATED="false" ;;
                esac
              done < <(git diff --name-only --diff-filter=U)
              if [ "$SAFE_GENERATED" = "true" ] && bunx projen; then
                git add -A
                if [ -z "$(git diff --name-only --diff-filter=U)" ]; then
                  git commit --no-edit
                  git push origin "HEAD:refs/heads/$SOURCE_BRANCH"
                  exit 0
                fi
              fi
              git merge --abort
              echo "::warning::source branch $SOURCE_BRANCH has handwritten or unresolved conflicts with released main; leaving it untouched"
            fi
          fi
        `
          // ============================================================================
        ),
      },
    ],
  });
}

class IndependentReleaseFinalizer extends Component {
  private finalized = false;

  constructor(
    project: DBXToolsJavaScriptProject,
    private readonly workflow: GithubWorkflow,
    private readonly docs: ReleaseDocsOptions | undefined,
    private readonly syncBranch: string | undefined,
  ) {
    super(project);
  }

  public override preSynthesize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const jobs = [...(independentPublicationJobs.get(this.workflow) ?? [])].sort();
    const successful = jobs
      .map((job) => `needs.${job}.result != 'failure' && needs.${job}.result != 'cancelled'`)
      .join(" && ");
    this.workflow.addJob("publication-complete", {
      if: `\${{ always()${successful ? ` && ${successful}` : ""} }}`,
      needs: jobs,
      runsOn: ["ubuntu-latest"],
      permissions: { contents: JobPermission.READ },
      steps: [{ name: "Confirm publication stages", run: "true" }],
    });
    if (this.docs) {
      addIndependentDocsJobs(this.workflow, this.project as DBXToolsJavaScriptProject, this.docs);
    }
    if (this.syncBranch) {
      addIndependentBranchSyncJob(
        this.workflow,
        this.project as DBXToolsJavaScriptProject,
        this.syncBranch,
      );
    }
  }
}

function configureIndependentRelease(
  project: DBXToolsJavaScriptProject,
  options: DBXToolsReleaseOptions,
): void {
  const branch = projectReleaseBranch(project);
  if (options.nodeRelease !== false) nodeReleaseProjects.add(project);
  applyTasks(project, {
    "version:check": {
      exec: taskScript(project, "version-check.ts"),
      description: "Verify every package against its release unit",
    },
    "release:plan": {
      exec: taskScript(project, "release-plan.ts"),
      receiveArgs: true,
      description: "Build the affected release plan",
    },
    release: {
      exec: taskScript(project, "release-request.ts", `--base ${JSON.stringify(branch)}`),
      receiveArgs: true,
      description: "Commit, annotate, and push a source release request",
    },
    "release:refresh": {
      exec: taskScript(project, "release-please.ts", `--target-branch ${JSON.stringify(branch)}`),
      receiveArgs: true,
      description: "Refresh Release Please PRs, tags, and GitHub Releases",
    },
  });
  if (!project.github) return;
  const workflow = new GithubWorkflow(project.github, "release", {
    fileName: "release.yml",
    limitConcurrency: true,
    concurrencyOptions: { group: "release", cancelInProgress: false },
  });
  workflow.runName =
    "release units " +
    "${{ github.event_name == 'push' && github.sha || inputs.automatic && 'automatic' || inputs.component }}";
  workflow.on({
    push: { branches: [branch] },
    workflowDispatch: {
      inputs: {
        automatic: {
          description: "Continue an automatically merged Release Please pull request",
          type: "boolean",
          default: "false",
          required: false,
        },
        component: {
          description: "Component to recover",
          type: "string",
          default: "",
          required: false,
        },
        version: {
          description: "Component version to recover",
          type: "string",
          default: "",
          required: false,
        },
        stage: {
          description: "Publication target to recover",
          type: "choice",
          options: ["all", "node", "python", "rust", "github", "docs"],
          default: "all",
          required: true,
        },
      },
    },
  });
  workflow.file?.addOverride("on.workflow_dispatch.inputs.automatic.default", false);
  workflow.file?.addOverride("permissions.contents", "read");
  workflow.addJob("release-please", independentReleasePleaseJob(project, branch));
  workflow.addJob("release-plan", independentReleasePlanJob(project));
  workflow.addJob("publish-release-notes", independentReleaseNotesJob(project));
  registerIndependentPublicationJob(workflow, "publish-release-notes");
  if (options.nodeRelease !== false) {
    workflow.addJob("publish-node", independentNodePublishJob(project));
    registerIndependentPublicationJob(workflow, "publish-node");
  }
  new IndependentReleaseFinalizer(project, workflow, options.docs, options.syncBranch || undefined);
  configureReleaseRequestWorkflow(project, branch);
  releaseWorkflows.set(project, workflow);
}

/** Owns the single release workflow and local release preparation tasks. */
export class DBXToolsRelease extends Component {
  constructor(project: DBXToolsJavaScriptProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    if (project.releaseCatalog.mode === "independent") {
      configureIndependentRelease(project, options);
      return;
    }
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
                "Prepare, validate, locally publish, and automatically merge a release PR",
            },
            "release:assets": {
              exec: taskScript(project, "release-assets.ts"),
              receiveArgs: true,
              description: "Build and upload native assets for an existing GitHub Release",
            },
          }
        : {}),
    });
    if (!project.github) return;

    const workflow = new GithubWorkflow(project.github, "release", {
      fileName: "release.yml",
      limitConcurrency: true,
      concurrencyOptions: { group: "release", cancelInProgress: false },
    });
    const version = readWorkspaceVersion(project.outdir);
    workflow.runName =
      `release ${version} ` +
      "${{ github.event_name == 'push' && github.sha || inputs.release_tag }}";
    workflow.on({
      push: { branches: [releaseBranch], paths: ["VERSION"] },
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
