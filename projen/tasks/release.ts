#!/usr/bin/env -S bun
/** Run the configured release transaction. */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import {
  captureGitTaskCommand,
  gitTaskCommandSucceeds,
  runGitTaskCommand,
  runTaskCommand,
} from "../src/_task-command.ts";
import { assertReleaseVersion } from "./release-version.ts";
import { readWorkspaceVersion } from "../src/workspace-version.ts";

const logger = log.logger("projen:release");

export function runRelease(options: {
  readonly root: string;
  readonly branch: string;
  readonly bump?: boolean;
  readonly prefix: string;
  readonly remote: string;
}): string {
  const { branch, prefix, remote, root } = options;
  const currentBranch = captureGitTaskCommand(root, ["branch", "--show-current"], { check: true });
  if (currentBranch !== branch) {
    throw new Error(
      `release must run on ${branch}, current branch is ${currentBranch || "detached"}`,
    );
  }

  if (options.bump ?? true) {
    const status = captureGitTaskCommand(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { check: true },
    );
    if (status) {
      throw new Error("release with automatic bump requires a clean working tree");
    }
    runTaskCommand(root, "bun", ["run", "bump"]);
  }

  const version = readWorkspaceVersion(root);
  const tag = `${prefix}${version}`;
  runGitTaskCommand(root, ["fetch", remote, branch, "--tags"]);
  assertReleaseVersion(version, { root, prefixes: [prefix], assertNext: true });

  if (gitTaskCommandSucceeds(root, ["rev-parse", "--verify", `refs/tags/${tag}`])) {
    throw new Error(`release tag ${tag} already exists`);
  }

  runTaskCommand(root, "bun", ["run", "version:check"]);
  const status = captureGitTaskCommand(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { check: true },
  );
  if (status) {
    if (gitTaskCommandSucceeds(root, ["diff", "--quiet", "HEAD", "--", "VERSION"])) {
      throw new Error("release changes must include the local VERSION bump");
    }
    runGitTaskCommand(root, ["add", "--all"]);
    runGitTaskCommand(root, ["commit", "-m", `chore(release): ${version}`]);
  }

  const remoteHead = captureGitTaskCommand(root, ["rev-parse", `${remote}/${branch}`], {
    check: true,
  });
  const head = captureGitTaskCommand(root, ["rev-parse", "HEAD"], { check: true });
  if (!gitTaskCommandSucceeds(root, ["merge-base", "--is-ancestor", remoteHead, head])) {
    throw new Error(`${branch} must contain ${remote}/${branch} before release`);
  }

  runGitTaskCommand(root, ["push", remote, `HEAD:${branch}`]);
  runGitTaskCommand(root, ["tag", "--annotate", tag, "--message", tag]);
  runGitTaskCommand(root, ["push", remote, `refs/tags/${tag}`]);
  logger.success(`released ${tag}`, { sha: head });
  return tag;
}

if (import.meta.main) {
  new Command()
    .option("--root <path>", "repository root")
    .option("--branch <name>", "release branch", "main")
    .option("--prefix <prefix>", "release tag prefix", "v")
    .option("--remote <name>", "git remote", "origin")
    .option("--no-bump", "use an existing synchronized local version bump")
    .action((options: { root?: string; branch: string; bump: boolean; prefix: string; remote: string }) => {
      runRelease({
        root: options.root ?? projectUtils.root() ?? process.cwd(),
        branch: options.branch,
        bump: options.bump,
        prefix: options.prefix,
        remote: options.remote,
      });
    })
    .parse();
}
