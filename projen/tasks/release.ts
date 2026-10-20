#!/usr/bin/env -S bun
/** Run the configured release transaction. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeArgs } from "@dbx-tools/cli-args";
import { projectUtils, type ProjectGhAccount, resolveProjectGhAccount } from "@dbx-tools/core";
import { log, toError, parse } from "@dbx-tools/shared-core";
import type { Command } from "commander";
import { z } from "zod";
import { parsedTaskOptions, runTaskMain, taskCommand } from "./cli.ts";
import { publishLocalRelease } from "./local-publish.ts";
import { TaskDirectoriesOptionSchema, TaskRootOptionSchema } from "./options.ts";
import { writeReleaseNotes } from "./release-notes.ts";
import { assertReleaseVersion } from "./release-version.ts";
import { captureTaskCommand, runTaskCommand, taskCommandSucceeds } from "../src/_task-command.ts";
import { RELEASE_WORKFLOW_FILE } from "../src/release-context.ts";
import {
  RELEASE_INSTALL_MODES,
  RELEASE_PUBLISH_TARGETS,
  releasePublishesLocally,
  releaseStepSelection,
  releaseTagAnnotation,
  type ReleaseInstallMode,
  type ReleaseSelectionOptions,
} from "../src/release-options.ts";
import { readWorkspaceVersion } from "../src/workspace-version.ts";

const logger = log.logger("projen:release");
const GITHUB_ACTIONS_START_TIMEOUT_MS = 2 * 60_000;
const GITHUB_ACTIONS_POLL_INTERVAL_MS = 2_000;

const GithubReleaseRunSchema = z
  .object({
    databaseId: z.number().int().positive(),
    headBranch: z.string(),
    headSha: z.string(),
    status: z.string(),
    url: z.string(),
  })
  .passthrough();

const GithubReleaseStepSchema = z
  .object({
    name: z.string(),
    number: z.number().int(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
  })
  .passthrough();

const GithubReleaseJobSchema = z
  .object({
    databaseId: z.number().int().positive(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    steps: z.array(GithubReleaseStepSchema),
  })
  .passthrough();

const GithubReleaseRunViewSchema = z
  .object({
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    jobs: z.array(GithubReleaseJobSchema),
  })
  .passthrough();

/** Inputs required to locate and watch one tag-triggered release workflow. */
export interface WatchReleaseGithubActionsOptions {
  readonly account: ProjectGhAccount;
  readonly head: string;
  readonly root: string;
  readonly tag: string;
  readonly pollIntervalMs?: number;
  readonly startTimeoutMs?: number;
}

/** GitHub release watcher boundary replaceable by release tests. */
export type ReleaseGithubActionsWatcher = (
  options: WatchReleaseGithubActionsOptions,
) => Promise<void>;

function githubRepository(account: ProjectGhAccount): string {
  return account.host === "github.com"
    ? account.remote.repository
    : `${account.host}/${account.remote.repository}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface GithubProgressEntry {
  readonly conclusion?: string | null;
  readonly key: string;
  readonly label: string;
  readonly status: string;
}

function githubProgressEntries(
  run: z.infer<typeof GithubReleaseRunViewSchema>,
): GithubProgressEntry[] {
  return [
    {
      key: "run",
      label: "release",
      status: run.status,
      conclusion: run.conclusion,
    },
    ...run.jobs.flatMap((job) => [
      {
        key: `job:${job.databaseId}`,
        label: job.name,
        status: job.status,
        conclusion: job.conclusion,
      },
      ...job.steps.map((step) => ({
        key: `job:${job.databaseId}:step:${step.number}`,
        label: `${job.name} / ${step.name}`,
        status: step.status,
        conclusion: step.conclusion,
      })),
    ]),
  ];
}

function githubProgressMarker(entry: GithubProgressEntry): string {
  if (entry.status === "completed") {
    if (entry.conclusion === "success") return "[done]";
    if (entry.conclusion === "skipped") return "[skip]";
    return "[fail]";
  }
  return entry.status === "in_progress" ? "[run]" : "[wait]";
}

function reportGithubProgress(
  run: z.infer<typeof GithubReleaseRunViewSchema>,
  previous: Map<string, string>,
): void {
  for (const entry of githubProgressEntries(run)) {
    const state = `${entry.status}:${entry.conclusion ?? ""}`;
    if (previous.get(entry.key) === state) continue;
    previous.set(entry.key, state);
    logger.info(`${githubProgressMarker(entry)} ${entry.label}`);
  }
}

/** Whether this release selection has remote work worth watching. */
export function shouldWatchReleaseGithubActions(
  options: Pick<ReleaseSelectionOptions, "publish"> & { readonly watchGithubActions?: boolean },
  selection: ReturnType<typeof releaseStepSelection>,
): boolean {
  if (options.watchGithubActions === false) return false;
  if (options.publish === "local" && !selection.npm && !selection.pypi && !selection.docs) {
    return false;
  }
  return Object.values(selection).some(Boolean);
}

/** Wait for a tag-triggered workflow, show live progress, then print its logs. */
export async function watchReleaseGithubActions(
  options: WatchReleaseGithubActionsOptions,
): Promise<void> {
  const {
    account,
    head,
    root,
    tag,
    pollIntervalMs = GITHUB_ACTIONS_POLL_INTERVAL_MS,
    startTimeoutMs = GITHUB_ACTIONS_START_TIMEOUT_MS,
  } = options;
  const repository = githubRepository(account);
  const deadline = Date.now() + startTimeoutMs;
  let run: z.infer<typeof GithubReleaseRunSchema> | undefined;
  while (!run && Date.now() < deadline) {
    const output = captureTaskCommand(
      root,
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        RELEASE_WORKFLOW_FILE,
        "--commit",
        head,
        "--event",
        "push",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch,headSha,status,url",
      ],
      { check: true, env: account.env, stderr: "inherit" },
    );
    const parsed = z.array(GithubReleaseRunSchema).safeParse(parse(output, []));
    if (!parsed.success) throw new Error("GitHub returned invalid release workflow metadata");
    run = parsed.data.find(
      (candidate) => candidate.headSha === head && candidate.headBranch === tag,
    );
    if (!run) await delay(pollIntervalMs);
  }
  if (!run) {
    logger.warn("GitHub Actions release run did not start before the watch timeout", {
      repository: account.remote.repository,
      tag,
    });
    return;
  }

  logger.info("watching GitHub Actions release", {
    repository: account.remote.repository,
    runId: run.databaseId,
    status: run.status,
    url: run.url,
  });
  try {
    const progress = new Map<string, string>();
    let completed = false;
    let conclusion: string | null | undefined;
    while (!completed) {
      const output = captureTaskCommand(
        root,
        "gh",
        [
          "run",
          "view",
          String(run.databaseId),
          "--repo",
          repository,
          "--json",
          "status,conclusion,jobs",
        ],
        { check: true, env: account.env, stderr: "inherit" },
      );
      const parsed = GithubReleaseRunViewSchema.safeParse(parse(output));
      if (!parsed.success) throw new Error("GitHub returned invalid release progress metadata");
      reportGithubProgress(parsed.data, progress);
      completed = parsed.data.status === "completed";
      conclusion = parsed.data.conclusion;
      if (!completed) await delay(pollIntervalMs);
    }
    if (conclusion !== "success" && conclusion !== "skipped") {
      runTaskCommand(
        root,
        "gh",
        ["run", "view", String(run.databaseId), "--repo", repository, "--log-failed"],
        { env: account.env },
      );
    }
  } catch (error) {
    logger.warn("GitHub Actions release watch stopped; the remote run was not cancelled", {
      error: toError(error),
      runId: run.databaseId,
      url: run.url,
    });
  }
}

/** Whether the root manifest exposes one repository-owned script. */
function hasPackageScript(root: string, name: string): boolean {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return Boolean(manifest.scripts?.[name]);
}

function gitHead(root: string, ref: string): string | undefined {
  if (!taskCommandSucceeds(root, "git", ["rev-parse", "--verify", ref])) return undefined;
  return captureTaskCommand(root, "git", ["rev-parse", ref], { check: true });
}

function assertAncestor(root: string, ancestor: string, descendant: string, message: string): void {
  if (!taskCommandSucceeds(root, "git", ["merge-base", "--is-ancestor", ancestor, descendant])) {
    throw new Error(message);
  }
}

/** Replace the local annotated tag object with the tag object created on the remote. */
export function refreshReleaseTagFromRemote(options: {
  readonly expectedObject: string;
  readonly remote: string;
  readonly root: string;
  readonly tag: string;
}): void {
  const { expectedObject, remote, root, tag } = options;
  const ref = `refs/tags/${tag}`;
  runTaskCommand(root, "git", ["fetch", "--force", remote, `${ref}:${ref}`]);
  const localObject = captureTaskCommand(root, "git", ["rev-parse", ref], { check: true });
  if (localObject !== expectedObject) {
    throw new Error(
      `remote ${tag} resolved to ${localObject || "<empty>"}, expected ${expectedObject}`,
    );
  }
}

function pushAnnotatedReleaseTag(options: {
  readonly annotation: string;
  readonly branch: string;
  readonly head: string;
  readonly remote: string;
  readonly root: string;
  readonly tag: string;
}): void {
  const { annotation, branch, head, remote, root, tag } = options;
  runTaskCommand(root, "git", ["tag", "--annotate", tag, "--message", annotation]);
  const githubAccount = resolveProjectGhAccount(root, { remote });
  if (!githubAccount) {
    logger.warn(
      "no authenticated GitHub account can access the release repository; using git push",
    );
    runTaskCommand(root, "git", ["push", remote, `refs/tags/${tag}`]);
    return;
  }

  const remoteBranch = captureTaskCommand(
    root,
    "git",
    ["ls-remote", remote, `refs/heads/${branch}`],
    { check: true },
  )
    .split(/\s+/)[0]
    ?.trim();
  if (remoteBranch !== head) {
    throw new Error(
      `cannot tag ${githubAccount.remote.repository}: ${remote}/${branch} does not equal local HEAD`,
    );
  }
  let remoteRefCreated = false;
  try {
    const tagObject = captureTaskCommand(
      root,
      "gh",
      [
        "api",
        "--hostname",
        githubAccount.host,
        "--method",
        "POST",
        `repos/${githubAccount.remote.repository}/git/tags`,
        "-f",
        `tag=${tag}`,
        "-f",
        `message=${annotation}`,
        "-f",
        `object=${head}`,
        "-f",
        "type=commit",
        "--jq",
        ".sha",
      ],
      { check: true, env: githubAccount.env, stderr: "inherit" },
    );
    if (!tagObject) throw new Error(`GitHub did not return an annotated tag object for ${tag}`);
    runTaskCommand(
      root,
      "gh",
      [
        "api",
        "--hostname",
        githubAccount.host,
        "--method",
        "POST",
        `repos/${githubAccount.remote.repository}/git/refs`,
        "-f",
        `ref=refs/tags/${tag}`,
        "-f",
        `sha=${tagObject}`,
        "--silent",
      ],
      { env: githubAccount.env },
    );
    remoteRefCreated = true;
    refreshReleaseTagFromRemote({ expectedObject: tagObject, remote, root, tag });
    logger.info(`created ${tag} through the GitHub API`, {
      account: githubAccount.login,
      host: githubAccount.host,
      repository: githubAccount.remote.repository,
      sha: head,
    });
  } catch (error) {
    if (remoteRefCreated) throw error;
    logger.warn("GitHub API tag creation failed; using git push", {
      error: toError(error),
      repository: githubAccount.remote.repository,
    });
    runTaskCommand(root, "git", ["push", remote, `refs/tags/${tag}`]);
  }
}

function prepareReleaseBranch(options: {
  readonly branch: string;
  readonly remote: string;
  readonly root: string;
}): void {
  const { branch, remote, root } = options;
  const sourceBranch = captureTaskCommand(root, "git", ["branch", "--show-current"], {
    check: true,
  });
  if (!sourceBranch) throw new Error("release cannot run from a detached HEAD");

  const status = captureTaskCommand(
    root,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { check: true },
  );
  if (status) {
    runTaskCommand(root, "git", ["add", "--all"]);
    runTaskCommand(root, "git", ["commit", "-m", "chore: prepare release"]);
  }

  runTaskCommand(root, "git", ["fetch", "--prune", remote, "--tags"]);
  const sourceHead = captureTaskCommand(root, "git", ["rev-parse", "HEAD"], { check: true });
  const remoteSourceHead = gitHead(root, `refs/remotes/${remote}/${sourceBranch}`);
  if (remoteSourceHead) {
    assertAncestor(
      root,
      remoteSourceHead,
      sourceHead,
      `cannot fast-forward ${remote}/${sourceBranch} to ${sourceBranch}`,
    );
  }
  runTaskCommand(root, "git", ["push", remote, `HEAD:${sourceBranch}`]);

  if (sourceBranch === branch) return;

  const remoteMain = gitHead(root, `refs/remotes/${remote}/${branch}`);
  if (!remoteMain) throw new Error(`release branch ${remote}/${branch} does not exist`);
  assertAncestor(
    root,
    remoteMain,
    sourceHead,
    `cannot safely merge ${sourceBranch} into ${branch}; ${branch} is not an ancestor`,
  );

  const localMain = gitHead(root, `refs/heads/${branch}`);
  if (localMain) {
    assertAncestor(
      root,
      localMain,
      sourceHead,
      `cannot safely fast-forward local ${branch} to ${sourceBranch}`,
    );
  } else {
    runTaskCommand(root, "git", ["branch", branch, `${remote}/${branch}`]);
  }
  runTaskCommand(root, "git", ["switch", branch]);
  runTaskCommand(root, "git", ["merge", "--ff-only", sourceBranch]);
  runTaskCommand(root, "git", ["push", remote, `HEAD:${branch}`]);
}

export async function runRelease(
  options: ReleaseSelectionOptions & {
    readonly root: string;
    readonly branch: string;
    readonly bump?: boolean;
    readonly prefix: string;
    readonly remote: string;
    readonly localPublish?: boolean;
    readonly localRegistry?: string;
    readonly localPypi?: string;
    readonly install?: ReleaseInstallMode;
    readonly pythonRoot?: string;
    readonly validationTasks?: readonly string[];
    /** After tagging, stage and deploy the AppKit demo app. Off by default. */
    readonly demoDeploy?: boolean;
    /** Optional Databricks CLI profile passed to the local demo deployment. */
    readonly demoProfile?: string;
    /** Write `docs/releases/vX.Y.Z.md` via Genie, with a git-log fallback. On by default. */
    readonly releaseNotes?: boolean;
    /** Additional instructions appended to the standard Genie release-notes prompt. */
    readonly releaseNotesInstructions?: string;
    /** Complete release notes supplied directly instead of invoking Genie. */
    readonly releaseNotesText?: string;
    /** Path to complete release notes supplied instead of invoking Genie. */
    readonly releaseNotesFile?: string;
    readonly writeReleaseNotes?: typeof writeReleaseNotes;
    /** After local release actions, wait for and stream the matching GitHub Actions run. */
    readonly watchGithubActions?: boolean;
    readonly githubActionsWatcher?: ReleaseGithubActionsWatcher;
    readonly resolveGithubAccount?: typeof resolveProjectGhAccount;
  },
): Promise<string> {
  const { branch, prefix, remote, root } = options;
  const selection = releaseStepSelection(options);
  const install = options.install ?? "auto";

  if (options.releaseNotesText !== undefined && options.releaseNotesFile !== undefined) {
    throw new Error("--release-notes-text and --release-notes-file are mutually exclusive");
  }
  if (
    options.releaseNotesInstructions !== undefined &&
    (options.releaseNotesText !== undefined || options.releaseNotesFile !== undefined)
  ) {
    throw new Error("--release-notes-instructions cannot be combined with supplied release notes");
  }
  if (
    options.releaseNotes === false &&
    (options.releaseNotesText !== undefined || options.releaseNotesFile !== undefined)
  ) {
    throw new Error("--no-release-notes cannot be combined with supplied release notes");
  }

  if (install === "always") runTaskCommand(root, "bun", ["install"]);
  if (selection.validation && hasPackageScript(root, "eslint:fix")) {
    runTaskCommand(root, "bun", ["run", "eslint:fix"]);
  }

  prepareReleaseBranch({ branch, remote, root });

  runTaskCommand(root, "git", ["fetch", remote, branch, "--tags"]);
  if (options.bump ?? true) {
    runTaskCommand(root, "bun", ["run", "bump"], {
      env: { ...process.env, DBX_TOOLS_RELEASE_INSTALL: install === "auto" ? "auto" : "never" },
    });
  }

  const version = readWorkspaceVersion(root);
  const tag = `${prefix}${version}`;
  assertReleaseVersion(version, { root, prefixes: [prefix], assertNext: true });

  if (taskCommandSucceeds(root, "git", ["rev-parse", "--verify", `refs/tags/${tag}`])) {
    throw new Error(`release tag ${tag} already exists`);
  }

  runTaskCommand(root, "bun", ["run", "version:check"]);
  for (const task of selection.validation ? (options.validationTasks ?? []) : []) {
    runTaskCommand(root, "bun", ["run", task]);
  }
  if ((options.releaseNotes ?? true) && (options.bump ?? true)) {
    (options.writeReleaseNotes ?? writeReleaseNotes)({
      prefix,
      root,
      version,
      content: options.releaseNotesText,
      file: options.releaseNotesFile,
      instructions: options.releaseNotesInstructions,
    });
  }
  const status = captureTaskCommand(
    root,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { check: true },
  );
  if (status) {
    if (!(options.bump ?? true)) {
      throw new Error("--no-bump requires an already committed synchronized version");
    }
    if (taskCommandSucceeds(root, "git", ["diff", "--quiet", "HEAD", "--", "VERSION"])) {
      throw new Error("release changes must include the local VERSION bump");
    }
    runTaskCommand(root, "git", ["add", "--all"]);
    runTaskCommand(root, "git", ["commit", "-m", `chore(release): ${version}`]);
  }

  const remoteHead = captureTaskCommand(root, "git", ["rev-parse", `${remote}/${branch}`], {
    check: true,
  });
  const head = captureTaskCommand(root, "git", ["rev-parse", "HEAD"], { check: true });
  if (!taskCommandSucceeds(root, "git", ["merge-base", "--is-ancestor", remoteHead, head])) {
    throw new Error(
      `cannot fast-forward ${remote}/${branch} to HEAD; ${branch} has diverged (rebase before release)`,
    );
  }

  runTaskCommand(root, "git", ["push", remote, `HEAD:${branch}`]);
  try {
    pushAnnotatedReleaseTag({
      annotation: releaseTagAnnotation(tag, selection),
      branch,
      head,
      remote,
      root,
      tag,
    });
  } catch (error) {
    if (taskCommandSucceeds(root, "git", ["rev-parse", "--verify", `refs/tags/${tag}`])) {
      runTaskCommand(root, "git", ["tag", "--delete", tag]);
    }
    throw error;
  }
  logger.success(`released ${tag}`, { sha: head });

  // Restore local deploys: when a non-standard (loopback) npm or uv registry is
  // configured, publish the freshly tagged version to it directly. Detection and
  // publishing are owned by local-publish.ts; this no-ops on standard registries.
  if ((options.localPublish ?? true) && releasePublishesLocally(options.publish)) {
    await publishLocalRelease({
      localPypi: options.pypi === false ? "false" : (options.localPypi ?? "auto"),
      localRegistry: options.npm === false ? "false" : (options.localRegistry ?? "auto"),
      pythonRoot: options.pythonRoot ?? "packages/py",
      root,
      version,
    });
  }

  if (options.demoDeploy) {
    const demoArgs = serializeArgs({
      ...(selection.validation ? {} : { validation: false }),
      ...(options.demoProfile ? { profile: options.demoProfile } : {}),
    });
    runTaskCommand(root, "bun", [
      "run",
      "demo:deploy",
      ...(demoArgs.length > 0 ? ["--", ...demoArgs] : []),
    ]);
  }

  if (shouldWatchReleaseGithubActions(options, selection)) {
    const account = (options.resolveGithubAccount ?? resolveProjectGhAccount)(root, {
      remote,
    });
    if (account) {
      await (options.githubActionsWatcher ?? watchReleaseGithubActions)({
        account,
        head,
        root,
        tag,
      });
    } else {
      logger.info("skipping GitHub Actions release watch: no authenticated account", {
        remote,
        tag,
      });
    }
  }

  return tag;
}

export const ReleaseOptionsSchema = z.object({
  root: TaskRootOptionSchema,
  branch: z.string().trim().min(1).default("main").describe("Release branch"),
  prefix: z.string().default("v").describe("Release tag prefix"),
  remote: z.string().trim().min(1).default("origin").describe("Git remote"),
  pythonRoot: z
    .string()
    .trim()
    .min(1)
    .default("packages/py")
    .describe("Python package root for local publish"),
  validate: TaskDirectoriesOptionSchema.describe("Repeatable task to run before pushing"),
  bump: z
    .boolean()
    .default(true)
    .describe("Create and synchronize a patch bump; disable only for an existing committed bump"),
  publish: z.enum(RELEASE_PUBLISH_TARGETS).default("auto").describe("Publication scope"),
  install: z
    .enum(RELEASE_INSTALL_MODES)
    .default("auto")
    .describe("Dependency install mode: auto follows manifests, always installs, never reuses"),
  npm: z.boolean().default(true).describe("Build and publish npm packages"),
  pypi: z.boolean().default(true).describe("Build and publish Python packages"),
  docs: z.boolean().optional().describe("Build and deploy documentation"),
  validation: z
    .boolean()
    .default(true)
    .describe("Run optional release validation tasks before publishing"),
  watchGithubActions: z
    .boolean()
    .default(true)
    .describe("Wait for and log the tag-triggered GitHub Actions release"),
  releaseNotes: z
    .boolean()
    .default(true)
    .describe("Generate and commit release notes for a new version bump"),
  releaseNotesText: z
    .string()
    .optional()
    .describe("Write supplied release-note Markdown without invoking Genie"),
  releaseNotesFile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Copy release-note Markdown from this file without invoking Genie"),
  releaseNotesInstructions: z
    .string()
    .optional()
    .describe("Append instructions to the Genie release-note prompt"),
  demoDeploy: z
    .boolean()
    .optional()
    .describe("Run the local-only AppKit demo deployment after tagging and publication"),
  profile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional Databricks CLI profile passed to the demo deployment"),
  localPublish: z.boolean().default(true).describe("Publish to configured local registries"),
  localRegistry: z
    .string()
    .trim()
    .min(1)
    .default("auto")
    .describe("Local npm registry selection: auto, false, or URL"),
  localPypi: z
    .string()
    .trim()
    .min(1)
    .default("auto")
    .describe("Local devpi registry selection: auto, false, or URL"),
});

/** Build the release task's schema-driven parser without executing release operations. */
export function createReleaseCommand(): Command {
  return taskCommand(
    import.meta.url,
    "Prepare an annotated release and select its build and publication steps",
    ReleaseOptionsSchema,
  ).action(async (_options: unknown, command: Command) => {
    const options = parsedTaskOptions(command, ReleaseOptionsSchema);
    await runRelease({
      root: options.root ?? projectUtils.root() ?? process.cwd(),
      branch: options.branch,
      bump: options.bump,
      prefix: options.prefix,
      remote: options.remote,
      pythonRoot: options.pythonRoot,
      localPublish: options.localPublish,
      localRegistry: options.localRegistry,
      localPypi: options.localPypi,
      install: options.install,
      publish: options.publish,
      npm: options.npm,
      pypi: options.pypi,
      docs: options.docs,
      validation: options.validation,
      watchGithubActions: options.watchGithubActions,
      validationTasks: options.validate,
      demoDeploy: options.demoDeploy,
      demoProfile: options.profile,
      releaseNotes: options.releaseNotes,
      releaseNotesInstructions: options.releaseNotesInstructions,
      releaseNotesText: options.releaseNotesText,
      releaseNotesFile: options.releaseNotesFile,
    });
  });
}

/** Execute the native release task parser. */
export async function main(): Promise<void> {
  await createReleaseCommand().parseAsync();
}

await runTaskMain(import.meta, main);
