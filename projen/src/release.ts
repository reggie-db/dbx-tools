/**
 * Release wiring: registers the `bump` task on a project (compute next version +
 * commit + tag + push), parameterized by the project's git tag prefix, and - when
 * the project has a GitHub component - authors the tag-driven npm publish
 * workflow that the pushed tag triggers.
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Component, YamlFile } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission, type JobStep } from "projen/lib/github/workflows-model";
import { object } from "@dbx-tools/shared-core";
import { applyTasks, taskScript, type DBXToolsNodeProject } from "./project.ts";
import {
  DOWNSTREAM_RELEASE_EVENT,
  RELEASE_SHA,
  RELEASE_TAG,
  RUST_RELEASE_EVENT,
  releaseSourceSteps,
} from "./release-dispatch.ts";

const NODE_VERSION = "lts/*";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const BUN_VERSION = "1.3.14";

/**
 * The `release` workflow's version-stamp + publish step, as a shell script.
 *
 * Bun has no `pnpm -r publish` equivalent, so this drives the engine's
 * `tasks/publish.ts` (shipped in the engine tarball, run via bun): it reads the
 * workspace members from the root `package.json`, ensures manifests and the Bun
 * lock carry the tag version so `workspace:*` siblings resolve to it, then
 * `bun publish`es each non-`private` package. The driver compiles publishable members once from the
 * root, then runs a bounded pool of `bun publish --ignore-scripts` calls so the
 * already-built packages upload concurrently. It also folds `publishConfig`'s
 * compiled `lib/` entry points into each packed manifest and honors
 * `NPM_CONFIG_PROVENANCE`.
 *
 * Two ways in: a pushed `<prefix>*` tag (the real release - `GITHUB_REF_NAME` is
 * the version) and a manual `workflow_dispatch` (no tag, so a throwaway
 * `0.0.0-dry.<run>` version is used and `--dry-run` is FORCED regardless of the
 * input, since a dispatch never has a tag to publish as). The `dry_run` input
 * (default true) is what lets a maintainer exercise the whole workflow - setup,
 * install, stamp, compile, pack, validate - with nothing reaching npm.
 */
function BUN_PUBLISH_SCRIPT(tagPrefix: string, excludeDirs: readonly string[]): string {
  const script = "node_modules/@dbx-tools/projen/tasks/publish.ts";
  const excludes = excludeDirs.map((dir) => ` --exclude ${dir}`).join("");
  return [
    'if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then',
    // A manual run has no tag: use a throwaway version and never really publish.
    '  VERSION="0.0.0-dry.${GITHUB_RUN_NUMBER}"',
    "  DRY_RUN=--dry-run",
    'elif [ -n "${RELEASE_VERSION:-}" ]; then',
    '  VERSION="$RELEASE_VERSION"',
    "  DRY_RUN=",
    "else",
    `  VERSION="\${GITHUB_REF_NAME#${tagPrefix}}"`,
    // A tag push honors the input too, so a dry-run tag can be tested if wanted.
    '  DRY_RUN="${DRY_RUN_INPUT}"',
    "fi",
    "chmod -R u+w . || true",
    `bun ${script} "$VERSION"${excludes} $DRY_RUN`,
  ].join("\n");
}

interface PublishWorkflow {
  readonly name: string;
  readonly tagPrefix: string;
  readonly steps: readonly JobStep[];
  readonly workingDirectory?: string;
  readonly upstreamWorkflow?: string;
}

/** Shared checkout and toolchain setup for every npm publish workflow. */
function publishSetupSteps(): JobStep[] {
  return [
    { name: "Checkout", uses: "actions/checkout@v6", with: { "fetch-depth": 0 } },
    { name: "Setup Bun", uses: "oven-sh/setup-bun@v2", with: { "bun-version": BUN_VERSION } },
    {
      name: "Setup Node.js",
      uses: "actions/setup-node@v6",
      // setup-node writes the temporary npmrc that maps NODE_AUTH_TOKEN onto
      // npmjs. Omitting this leaves the secret in the environment but gives npm
      // no registry-scoped auth entry, and every publish fails with ENEEDAUTH.
      // (Bun installs deps; publishing still goes through `npm publish`.)
      with: { "node-version": NODE_VERSION, "registry-url": NPM_REGISTRY_URL },
    },
    // Bun's install; the lockfile may be absent or stale in CI so it is not frozen.
    { name: "Install", run: "bun install" },
  ];
}

/**
 * A standalone project that lives in a repo SUBDIRECTORY but is NOT a member of
 * this pnpm workspace (e.g. the `@dbx-tools/projen` engine in `projen/`), yet
 * still needs a release workflow. GitHub Actions only runs workflows from the
 * REPO-ROOT `.github/`, so the workflow for such a project is authored here,
 * alongside the root's own `release` workflow, under a distinct name + tag
 * prefix so the two never collide. Tag-driven and pack-based: push
 * `<tagPrefix>1.2.3` and the single package in `directory` is published at 1.2.3
 * via `npm pack` + `npm publish`.
 *
 * Declaring one also enlists it in the root's `bump`, which cuts BOTH tags at one
 * shared version. The separate tag namespace still lets it be released alone
 * (`cd <directory> && bun run bump`) for a consumer who wants only this package.
 * Enlisting it is what keeps a routine root bump from leaving it behind and letting
 * its version drift away from the packages'.
 */
export interface StandaloneRelease {
  /** Workflow name (and `.github/workflows/<name>.yml` file). E.g. `projen-release`. */
  readonly name: string;
  /** Repo-relative directory of the standalone project. E.g. `projen`. */
  readonly directory: string;
  /**
   * Git tag prefix that triggers this release, disjoint from the root's `v*`
   * (e.g. `projen-v`). The pushed tag IS the published version.
   */
  readonly tagPrefix: string;
}

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /**
   * Git tag prefix for this project's releases (e.g. `v` or `projen-v`). The
   * `bump` task reads/writes `<prefix><version>` tags, keeping sibling projects
   * in the same repo on disjoint tag namespaces. Defaults to `v`.
   */
  readonly tagPrefix?: string;
  /**
   * Standalone in-repo projects (NOT workspace members) that each get their own
   * tag-driven release workflow authored alongside the root's - see
   * {@link StandaloneRelease}. Authored only when the project has a GitHub
   * component. Defaults to none.
   */
  readonly standaloneReleases?: readonly StandaloneRelease[];
  /** Run the main Node release after this workflow completes successfully. */
  readonly upstreamWorkflow?: string;
  /** Main Node release workflow name. Defaults to `node-release`. */
  readonly workflowName?: string | false;
}

/**
 * Adds a `bump` task: compute the next release version (from the higher of the
 * latest `<prefix>*` git tag and the local `package.json`), then commit, tag,
 * and push it - pushing the tag is what triggers the release workflow. Each step
 * is toggleable (`--no-version` / `--no-commit` / `--no-tag` / `--no-push` /
 * `--no-publish`); see `tasks/bump.ts`.
 *
 * When the project has a GitHub component (`github: true`), also authors the
 * `release` workflow: on a pushed `<prefix>*` tag it sets that version on every
 * publishable package and runs `pnpm -r publish` (which skips
 * `private` packages and honors each package's `publishConfig`).
 *
 * Provenance is opt-in. Each package's generated `publishConfig` omits
 * `provenance`, so LOCAL publishes (e.g. to a verdaccio) never try to attest -
 * npm has no CI OIDC provider off-CI and would fail with `provider: null`. This
 * CI workflow turns it on with `npm_config_provenance=true`, backed by the
 * `id-token: write` permission that lets npm mint the OIDC token.
 *
 * Registry AUTH is still `NPM_TOKEN`, deliberately. OIDC here mints the
 * provenance attestation only; full npm trusted publishing would additionally
 * replace the token, but it has to be registered per package on npmjs.com
 * against an exact repo + workflow filename, and this repo publishes 26 of
 * them. That is a considered deferral, not an oversight - do not "fix" it by
 * dropping the token without doing the registrations first, or every publish
 * fails.
 */
export class DBXToolsRelease extends Component {
  private readonly tagPrefix: string;
  private readonly standaloneReleases: readonly StandaloneRelease[];
  private readonly upstreamWorkflow?: string;
  private readonly workflowName: string | false;

  constructor(project: DBXToolsNodeProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    this.tagPrefix = options.tagPrefix ?? "v";
    this.standaloneReleases = options.standaloneReleases ?? [];
    this.upstreamWorkflow = options.upstreamWorkflow;
    this.workflowName = options.workflowName ?? "node-release";
    if (project.github) this.authorReleaseDispatcher(project);
  }

  public override preSynthesize(): void {
    const project = this.project as DBXToolsNodeProject;
    const rust = project.dbxToolsConfig.rust;
    if (
      !this.workflowName &&
      this.standaloneReleases.length === 0 &&
      typeof project.dbxToolsConfig.pythonReleaseWorkflow !== "string" &&
      !(object.isRecord(rust) && typeof rust.releaseWorkflow === "string")
    ) {
      project.tryRemoveFile(".github/workflows/release-dispatch.yml");
    }
    const releaseEvent =
      object.isRecord(rust) && typeof rust.releaseWorkflow === "string"
        ? RUST_RELEASE_EVENT
        : DOWNSTREAM_RELEASE_EVENT;
    const dispatcher = project.tryFindObjectFile(".github/workflows/release-dispatch.yml");
    dispatcher?.addOverride("jobs.dispatch.steps.1.env.RELEASE_EVENT", releaseEvent);
    const releaseWorkflows = [
      ...(object.isRecord(rust) && typeof rust.releaseWorkflow === "string"
        ? [rust.releaseWorkflow]
        : []),
      ...(typeof project.dbxToolsConfig.pythonReleaseWorkflow === "string"
        ? [project.dbxToolsConfig.pythonReleaseWorkflow]
        : []),
      ...(this.workflowName ? [this.workflowName] : []),
      ...this.standaloneReleases.map(({ name }) => name),
      ...(existsSync(resolve(project.outdir, ".github/workflows/docs.yml")) ? ["docs"] : []),
    ];
    dispatcher?.addOverride(
      "jobs.dispatch.steps.1.env.RELEASE_WORKFLOWS",
      [...new Set(releaseWorkflows)].join(","),
    );
    // Release the standalone projects in the SAME run, at the same version. They
    // are not workspace members, so nothing else would ever bring them along.
    const siblingArgs = this.standaloneReleases
      .map(({ directory, tagPrefix }) => ` --sibling ${directory}:${tagPrefix}`)
      .join("");
    applyTasks(project, {
      bump: {
        exec: taskScript(project, "bump.ts", `--prefix ${this.tagPrefix}${siblingArgs}`),
        receiveArgs: true,
        description: "Bump the release version (default patch), then commit, tag, and push it",
      },
    });

    // Author the tag-driven publish workflows only when GitHub is enabled - they
    // live in `.github/`, which requires projen's GitHub component.
    if (project.github) {
      if (this.workflowName) this.authorReleaseWorkflow(project);
      for (const standalone of this.standaloneReleases) {
        this.authorStandaloneReleaseWorkflow(project, standalone);
      }
    }
  }

  public override postSynthesize(): void {
    rmSync(resolve(this.project.outdir, ".github/workflows/rust-release-dispatch.yml"), {
      force: true,
    });
  }

  private authorReleaseDispatcher(project: DBXToolsNodeProject): void {
    new YamlFile(project, ".github/workflows/release-dispatch.yml", {
      obj: {
        name: "release-dispatch",
        on: { push: { tags: [`${this.tagPrefix}*`] } },
        concurrency: {
          group: "release-dispatch",
          "cancel-in-progress": true,
        },
        permissions: { actions: "write", contents: "write" },
        jobs: {
          dispatch: {
            "runs-on": "ubuntu-latest",
            steps: [
              {
                name: "Checkout release tag",
                uses: "actions/checkout@v6",
                with: { "fetch-depth": 1 },
              },
              {
                name: "Dispatch release",
                shell: "bash",
                env: {
                  GH_TOKEN: "${{ github.token }}",
                  RELEASE_TAG: "${{ github.ref_name }}",
                  RELEASE_EVENT: DOWNSTREAM_RELEASE_EVENT,
                  RELEASE_WORKFLOWS: "",
                },
                run: [
                  `case "$RELEASE_TAG" in ${this.tagPrefix}*) ;; *) exit 1 ;; esac`,
                  'EXPECTED_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"',
                  'IFS="," read -r -a workflows <<< "$RELEASE_WORKFLOWS"',
                  'for workflow in "${workflows[@]}"; do',
                  "  for status in in_progress queued requested waiting pending action_required; do",
                  "    while IFS= read -r run_id; do",
                  '      if [ -n "$run_id" ]; then gh run cancel "$run_id"; fi',
                  '    done < <(gh run list --workflow "$workflow.yml" --status "$status" --limit 100 --json databaseId --jq \'.[].databaseId\')',
                  "  done",
                  "done",
                  [
                    'gh api --method POST "repos/$GITHUB_REPOSITORY/dispatches"',
                    '--raw-field event_type="$RELEASE_EVENT"',
                    '--raw-field "client_payload[release_tag]=$RELEASE_TAG"',
                    '--raw-field "client_payload[expected_sha]=$EXPECTED_SHA"',
                  ].join(" \\\n  "),
                ].join("\n"),
              },
            ],
          },
        },
      },
    });
  }

  /** Author the common tag trigger, concurrency policy, permissions, and publish job. */
  private authorPublishWorkflow(
    project: DBXToolsNodeProject,
    { name, tagPrefix, steps, workingDirectory, upstreamWorkflow }: PublishWorkflow,
  ): void {
    const setupSteps = publishSetupSteps();
    const branchDispatch = upstreamWorkflow === undefined;
    const workflow = new GithubWorkflow(project.github!, name, {
      // A newer release supersedes an older run even when publication has
      // started; the dispatcher also cancels active ecosystem runs immediately.
      limitConcurrency: true,
      concurrencyOptions: { group: name, cancelInProgress: true },
    });
    // Read-only floor for any job that does not declare its own permissions;
    // the publish job below overrides it with the `id-token` it needs.
    workflow.file?.addOverride("permissions", {
      contents: "read",
      ...(upstreamWorkflow ? { actions: "read" } : {}),
    });
    if (upstreamWorkflow) {
      workflow.file?.addOverride("on.workflow_run", {
        workflows: [upstreamWorkflow],
        types: ["completed"],
      });
    } else {
      workflow.file?.addOverride("on.repository_dispatch", {
        types: [DOWNSTREAM_RELEASE_EVENT],
      });
    }
    // Manual trigger for testing the workflow WITHOUT reaching npm: a
    // `workflow_dispatch` run has no tag, so the publish script forces
    // `--dry-run` (pack + validate only). The `dry_run` input (default true)
    // additionally lets a tag push be dry-run on demand.
    workflow.file?.addOverride("on.workflow_dispatch", {
      inputs: {
        ...(branchDispatch
          ? {
              release_tag: {
                description: "Release tag to package during a dry run",
                type: "string",
                required: true,
              },
              expected_sha: {
                description: "Commit the release tag must reference",
                type: "string",
                required: true,
              },
            }
          : {}),
        dry_run: {
          description: "Pack and validate but do not upload to npm",
          type: "boolean",
          default: true,
        },
      },
    });
    workflow.addJob("publish", {
      ...(upstreamWorkflow
        ? {
            if: "${{ github.event_name != 'workflow_run' || (github.event.workflow_run.conclusion == 'success' && (github.event.workflow_run.event == 'workflow_run' || github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'repository_dispatch')) }}",
          }
        : {}),
      runsOn: ["ubuntu-latest"],
      // `id-token: write` lets npm mint the OIDC token for provenance attestation.
      permissions: {
        ...(upstreamWorkflow ? { actions: JobPermission.READ } : {}),
        contents: JobPermission.READ,
        idToken: JobPermission.WRITE,
      },
      timeoutMinutes: 30,
      // `DRY_RUN_INPUT` is `--dry-run` when the dispatch input is true, else empty;
      // the publish script also FORCES it on any `workflow_dispatch` run.
      env: {
        CI: "true",
        DRY_RUN_INPUT: "${{ github.event.inputs.dry_run == 'true' && '--dry-run' || '' }}",
      },
      steps: [
        ...(upstreamWorkflow
          ? [
              {
                name: "Download release metadata",
                uses: "actions/download-artifact@v8",
                with: {
                  name: "release-metadata",
                  path: ".release",
                  "run-id": "${{ github.event.workflow_run.id }}",
                  "github-token": "${{ github.token }}",
                },
              },
              {
                name: "Read release metadata",
                id: "release_metadata",
                shell: "bash",
                run: [
                  'RELEASE_TAG="$(cat .release/tag)"',
                  'EXPECTED_SHA="$(cat .release/sha)"',
                  'test -n "$RELEASE_TAG"',
                  'test -n "$EXPECTED_SHA"',
                  'echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"',
                  'echo "expected_sha=$EXPECTED_SHA" >> "$GITHUB_OUTPUT"',
                ].join("\n"),
              },
            ]
          : []),
        {
          ...setupSteps[0]!,
          ...(upstreamWorkflow
            ? {
                with: {
                  ...setupSteps[0]!.with,
                  ref: "${{ steps.release_metadata.outputs.expected_sha }}",
                  "fetch-depth": 0,
                },
              }
            : {
                with: {
                  ...setupSteps[0]!.with,
                  ref: RELEASE_SHA,
                  "fetch-depth": 1,
                },
              }),
        },
        ...(upstreamWorkflow
          ? [
              {
                name: "Verify release source",
                shell: "bash",
                env: {
                  SOURCE_RELEASE_TAG: "${{ steps.release_metadata.outputs.release_tag }}",
                  EXPECTED_SHA: "${{ steps.release_metadata.outputs.expected_sha }}",
                },
                run: [
                  'git fetch --force origin "+refs/tags/$SOURCE_RELEASE_TAG:refs/tags/$SOURCE_RELEASE_TAG"',
                  'test "$(git rev-parse "$SOURCE_RELEASE_TAG^{commit}")" = "$EXPECTED_SHA"',
                  'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
                  `RELEASE_TAG="$(git tag --points-at HEAD --list "${tagPrefix}*" | sort -V | tail -1)"`,
                  'test -n "$RELEASE_TAG"',
                  'echo "RELEASE_TAG=$RELEASE_TAG" >> "$GITHUB_ENV"',
                  `echo "RELEASE_VERSION=\${RELEASE_TAG#${tagPrefix}}" >> "$GITHUB_ENV"`,
                ].join("\n"),
              } satisfies JobStep,
            ]
          : []),
        ...(branchDispatch ? releaseSourceSteps().slice(1) : []),
        ...(branchDispatch
          ? [
              {
                name: "Resolve package release tag",
                shell: "bash",
                env: {
                  SOURCE_RELEASE_TAG: RELEASE_TAG,
                  EXPECTED_SHA: RELEASE_SHA,
                },
                run: [
                  `SOURCE_VERSION="\${SOURCE_RELEASE_TAG#${this.tagPrefix}}"`,
                  `RELEASE_TAG="${tagPrefix}\${SOURCE_VERSION}"`,
                  'git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
                  'test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$EXPECTED_SHA"',
                  'echo "RELEASE_TAG=$RELEASE_TAG" >> "$GITHUB_ENV"',
                  `echo "RELEASE_VERSION=\${RELEASE_TAG#${tagPrefix}}" >> "$GITHUB_ENV"`,
                  "mkdir -p .release",
                  'printf "%s\\n" "$SOURCE_RELEASE_TAG" > .release/tag',
                  'printf "%s\\n" "$EXPECTED_SHA" > .release/sha',
                ].join("\n"),
              } satisfies JobStep,
            ]
          : []),
        ...setupSteps.slice(1),
        {
          name: "Upload release metadata",
          uses: "actions/upload-artifact@v7",
          with: { name: "release-metadata", path: ".release" },
        },
        ...steps,
      ],
      ...(workingDirectory ? { defaults: { run: { workingDirectory } } } : {}),
    });
  }

  /**
   * Emit the `release` GitHub workflow: push `<prefix>1.2.3` and every
   * publishable package is published to npm at 1.2.3. Setting the
   * version on every package first makes the pushed tag the published version
   * (no bump math).
   */
  private authorReleaseWorkflow(project: DBXToolsNodeProject): void {
    if (!this.workflowName) return;
    if (this.workflowName !== "release") project.tryRemoveFile(".github/workflows/release.yml");
    this.authorPublishWorkflow(project, {
      name: this.workflowName,
      tagPrefix: this.tagPrefix,
      upstreamWorkflow: this.upstreamWorkflow,
      steps: [
        // The pushed tag is the version: `<prefix>1.2.3` -> `1.2.3`. Stamp it on
        // every workspace package (manifests are projen-readonly, so unlock
        // first), rewriting `workspace:*` sibling deps to `^<version>` so the
        // published tarballs resolve each other. `bun publish` honors
        // `publishConfig` (compiled `lib/` entry points) and provenance.
        {
          name: "Set version from tag and publish",
          // Exclude every standalone-release dir (e.g. `projen`): it publishes on
          // its own `<prefix>-v*` tag via its own workflow, not the main `v*` one.
          run: BUN_PUBLISH_SCRIPT(
            this.tagPrefix,
            this.standaloneReleases.map((s) => s.directory),
          ),
          env: {
            // `bun publish` authenticates via NPM_CONFIG_TOKEN (not NODE_AUTH_TOKEN,
            // which is the `npm publish` convention). Set both so either tool works.
            NPM_CONFIG_TOKEN: "${{ secrets.NPM_TOKEN }}",
            NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
            NPM_CONFIG_PROVENANCE: "true",
          },
        },
      ],
    });
  }

  /**
   * Emit a {@link StandaloneRelease}'s workflow: push `<prefix>1.2.3` and the
   * single package in `directory` is published at 1.2.3 via `bun publish`.
   *
   * `directory` (e.g. `projen/`) is a WORKSPACE MEMBER whose `@dbx-tools/*` deps
   * are `workspace:*`. `bun publish` resolves those to whatever version its
   * SIBLINGS carry (via the lockfile), so before publishing we re-affirm the
   * version on the package AND its in-scope siblings, then refresh the lockfile -
   * otherwise a stale resolved version could reach the published engine. The
   * `Install` step already ran `bun install` from the repo root (the member
   * subdir walks up to it), so the workspace is linked. The manifests are
   * projen-readonly, hence the `chmod`. A manual `workflow_dispatch` run has no
   * tag, so it uses a throwaway version and forces `--dry-run` (nothing to npm).
   */
  private authorStandaloneReleaseWorkflow(
    project: DBXToolsNodeProject,
    { name, directory, tagPrefix }: StandaloneRelease,
  ): void {
    // The engine's release also stamps its in-scope siblings so `bun publish`
    // resolves their `workspace:*` to the release version. Stamping the WHOLE
    // workspace is simplest and harmless (only `directory` is published here).
    const stampScript = "node_modules/@dbx-tools/projen/tasks/publish.ts";
    this.authorPublishWorkflow(project, {
      name,
      tagPrefix,
      upstreamWorkflow: this.upstreamWorkflow,
      steps: [
        {
          name: "Set version from tag and publish",
          run: [
            'if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then',
            '  VERSION="0.0.0-dry.${GITHUB_RUN_NUMBER}"',
            "  DRY_RUN=--dry-run",
            "else",
            `  VERSION="\${RELEASE_VERSION:-\${GITHUB_REF_NAME#${tagPrefix}}}"`,
            '  DRY_RUN="${DRY_RUN_INPUT}"',
            "fi",
            "chmod -R u+w . || true",
            // Set the version across every member + refresh the lockfile (the
            // publish task's stamp phase), so bun resolves the engine's
            // `workspace:*` sibling deps to the release version at pack time.
            `bun ${stampScript} "$VERSION" --stamp-only`,
            // Then publish ONLY the standalone directory.
            `cd ${directory} && bun publish --access public $DRY_RUN`,
          ].join("\n"),
          env: {
            // `bun publish` authenticates via NPM_CONFIG_TOKEN (not NODE_AUTH_TOKEN,
            // which is the `npm publish` convention). Set both so either tool works.
            NPM_CONFIG_TOKEN: "${{ secrets.NPM_TOKEN }}",
            NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
            NPM_CONFIG_PROVENANCE: "true",
          },
        },
      ],
    });
  }
}
