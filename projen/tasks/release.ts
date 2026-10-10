#!/usr/bin/env -S bun
/** Run the configured release transaction. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import type { Command } from "commander";
import { z } from "zod";
import { parsedTaskOptions, runTaskMain, taskCommand } from "./cli.ts";
import { publishLocalRelease } from "./local-publish.ts";
import { TaskDirectoriesOptionSchema, TaskRootOptionSchema } from "./options.ts";
import { writeReleaseNotes } from "./release-notes.ts";
import { assertReleaseVersion } from "./release-version.ts";
import { captureTaskCommand, runTaskCommand, taskCommandSucceeds } from "../src/_task-command.ts";
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
  const githubAccount = projectUtils.resolveProjectGhAccount(root, { remote });
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
      error,
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
    /** Explicit Databricks CLI profile used by the optional demo deployment. */
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
  },
): Promise<string> {
  const { branch, prefix, remote, root } = options;
  const selection = releaseStepSelection(options);
  const install = options.install ?? "auto";
  const demoProfile = options.demoProfile?.trim();

  if (options.demoDeploy && !demoProfile) {
    throw new Error("--demo-deploy requires --profile <name>");
  }
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

  if (options.demoDeploy && demoProfile) {
    runTaskCommand(root, "bun", ["run", "demo:deploy", "--profile", demoProfile]);
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
  bump: z.boolean().default(true).describe("Create and synchronize a patch version bump"),
  publish: z.enum(RELEASE_PUBLISH_TARGETS).default("auto").describe("Publication scope"),
  install: z
    .enum(RELEASE_INSTALL_MODES)
    .default("auto")
    .describe("Local workspace dependency installation"),
  npm: z.boolean().default(true).describe("Build and publish npm packages"),
  pypi: z.boolean().default(true).describe("Build and publish Python packages"),
  docs: z.boolean().optional().describe("Build and deploy documentation"),
  validation: z
    .boolean()
    .default(true)
    .describe("Run optional release validation tasks before publishing"),
  releaseNotes: z.boolean().default(true).describe("Write release notes before tagging"),
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
    .describe("Deploy the AppKit demo after tagging and local publication"),
  profile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Explicit Databricks CLI profile for demo deployment")
    .meta({ env: [], helpDefault: false }),
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
