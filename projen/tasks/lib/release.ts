#!/usr/bin/env -S bun
/** Run the configured release transaction. */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { publishLocalRelease } from "./local-publish.ts";
import { assertReleaseVersion } from "./release-version.ts";
import {
  captureTaskCommand,
  runTaskCommand,
  taskCommandSucceeds,
} from "../../src/_task-command.ts";
import { readWorkspaceVersion } from "../../src/workspace-version.ts";

const logger = log.logger("projen:release");

function gitHead(root: string, ref: string): string | undefined {
  if (!taskCommandSucceeds(root, "git", ["rev-parse", "--verify", ref])) return undefined;
  return captureTaskCommand(root, "git", ["rev-parse", ref], { check: true });
}

function assertAncestor(root: string, ancestor: string, descendant: string, message: string): void {
  if (!taskCommandSucceeds(root, "git", ["merge-base", "--is-ancestor", ancestor, descendant])) {
    throw new Error(message);
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

export async function runRelease(options: {
  readonly root: string;
  readonly branch: string;
  readonly bump?: boolean;
  readonly prefix: string;
  readonly remote: string;
  readonly localPublish?: boolean;
  readonly pythonRoot?: string;
  readonly validationTasks?: readonly string[];
}): Promise<string> {
  const { branch, prefix, remote, root } = options;

  prepareReleaseBranch({ branch, remote, root });

  runTaskCommand(root, "git", ["fetch", remote, branch, "--tags"]);
  if (options.bump ?? true) {
    runTaskCommand(root, "bun", ["run", "bump"]);
  }

  const version = readWorkspaceVersion(root);
  const tag = `${prefix}${version}`;
  assertReleaseVersion(version, { root, prefixes: [prefix], assertNext: true });

  if (taskCommandSucceeds(root, "git", ["rev-parse", "--verify", `refs/tags/${tag}`])) {
    throw new Error(`release tag ${tag} already exists`);
  }

  runTaskCommand(root, "bun", ["run", "version:check"]);
  for (const task of options.validationTasks ?? []) {
    runTaskCommand(root, "bun", ["run", task]);
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

  runTaskCommand(root, "git", ["tag", "--annotate", tag, "--message", tag]);
  try {
    runTaskCommand(root, "git", ["push", "--atomic", remote, `HEAD:${branch}`, `refs/tags/${tag}`]);
  } catch (error) {
    runTaskCommand(root, "git", ["tag", "--delete", tag]);
    throw error;
  }
  logger.success(`released ${tag}`, { sha: head });

  // Restore local deploys: when a non-standard (loopback) npm or uv registry is
  // configured, publish the freshly tagged version to it directly. Detection and
  // publishing are owned by local-publish.ts; this no-ops on standard registries.
  if (options.localPublish ?? true) {
    await publishLocalRelease({
      localPypi: "auto",
      localRegistry: "auto",
      pythonRoot: options.pythonRoot ?? "packages/py",
      root,
      version,
    });
  }

  return tag;
}

export async function main(): Promise<void> {
  await new Command()
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
    .option("--no-local-publish", "skip publishing to configured local registries")
    .action(
      async (options: {
        root?: string;
        branch: string;
        bump: boolean;
        prefix: string;
        remote: string;
        pythonRoot: string;
        localPublish: boolean;
        validate: string[];
      }) => {
        await runRelease({
          root: options.root ?? projectUtils.root() ?? process.cwd(),
          branch: options.branch,
          bump: options.bump,
          prefix: options.prefix,
          remote: options.remote,
          pythonRoot: options.pythonRoot,
          localPublish: options.localPublish,
          validationTasks: options.validate,
        });
      },
    )
    .parseAsync();
}
