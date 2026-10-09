#!/usr/bin/env -S bun
/** Run the configured release transaction. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { publishLocalRelease } from "./local-publish.ts";
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
    logger.warn("no authenticated GitHub account can access the release repository; using git push");
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
    logger.info(`created ${tag} through the GitHub API`, {
      account: githubAccount.login,
      host: githubAccount.host,
      repository: githubAccount.remote.repository,
      sha: head,
    });
  } catch (error) {
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
    /** Write `docs/releases/vX.Y.Z.md` via Genie, with a git-log fallback. On by default. */
    readonly releaseNotes?: boolean;
    /** Additional instructions appended to the standard Genie release-notes prompt. */
    readonly releaseNotesInstructions?: string;
    readonly writeReleaseNotes?: typeof writeReleaseNotes;
  },
): Promise<string> {
  const { branch, prefix, remote, root } = options;
  const selection = releaseStepSelection(options);
  const install = options.install ?? "auto";

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
    runTaskCommand(root, "bun", ["run", "demo:deploy"]);
  }

  return tag;
}

/** Build the release task's native parser without executing git or registry operations. */
export function createReleaseCommand(): Command {
  return new Command()
    .name("release")
    .description("Prepare an annotated release and select its build and publication steps")
    .option("--root <path>", "repository root")
    .option("--branch <name>", "release branch", "main")
    .option("--prefix <prefix>", "release tag prefix", "v")
    .option("--remote <name>", "git remote", "origin")
    .option("--python-root <path>", "Python package root for local publish", "packages/py")
    .option(
      "--validate <task>",
      "task to run before pushing",
      (task, tasks: string[]) => [...tasks, task],
      [],
    )
    .option("--no-bump", "use an existing synchronized local version bump")
    .addOption(
      new Option("--publish <target>", "publication scope")
        .choices([...RELEASE_PUBLISH_TARGETS])
        .default("auto"),
    )
    .addOption(
      new Option("--install <mode>", "local workspace dependency installation")
        .choices([...RELEASE_INSTALL_MODES])
        .default("auto"),
    )
    .option("--no-npm", "skip npm build and publication, including local npm publication")
    .option("--no-pypi", "skip Python build and publication, including local Python publication")
    .option("--docs", "build and deploy docs for a selected scope")
    .option("--no-docs", "skip documentation build and deployment")
    .option(
      "--no-validation",
      "skip optional release validation tasks; version/source checks remain mandatory",
    )
    .option("--no-release-notes", "skip writing docs/releases notes (Genie and git-log fallback)")
    .option(
      "--release-notes-instructions <text>",
      "append custom instructions to the Genie release-notes prompt",
    )
    .option("--demo-deploy", "after tagging, stage and deploy the AppKit demo app (off by default)")
    .option("--no-local-publish", "skip publishing to configured local registries")
    .option("--local-registry <auto|false|url>", "local npm registry selection", "auto")
    .option("--local-pypi <auto|false|url>", "local devpi registry selection", "auto")
    .action(
      async (
        options: ReleaseSelectionOptions & {
          root?: string;
          branch: string;
          bump: boolean;
          prefix: string;
          remote: string;
          pythonRoot: string;
          localPublish: boolean;
          localRegistry: string;
          localPypi: string;
          install: ReleaseInstallMode;
          validate: string[];
          demoDeploy?: boolean;
          releaseNotes?: boolean;
          releaseNotesInstructions?: string;
        },
      ) => {
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
          releaseNotes: options.releaseNotes,
          releaseNotesInstructions: options.releaseNotesInstructions,
        });
      },
    );
}

/** Execute the native release task parser. */
export async function main(): Promise<void> {
  await createReleaseCommand().parseAsync();
}

if (import.meta.main) await main();
