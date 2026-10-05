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
import { publishLocalRelease } from "./local-publish.ts";
import { readWorkspaceVersion } from "../src/workspace-version.ts";

const logger = log.logger("projen:release");

export async function runRelease(options: {
  readonly root: string;
  readonly branch: string;
  readonly bump?: boolean;
  readonly prefix: string;
  readonly remote: string;
  readonly localPublish?: boolean;
  readonly pythonRoot?: string;
}): Promise<string> {
  const { branch, prefix, remote, root } = options;

  // Release runs from any branch: whatever is checked out is fast-forwarded onto
  // `branch`. The working tree is committed into the release commit unless it is
  // already clean - the clean tree is a convenience, not a precondition.
  if (options.bump ?? true) {
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

  // Fast-forward only: HEAD must already contain the remote branch tip, otherwise
  // the push would be a non-fast-forward (an unclean merge) and we fail instead
  // of force-pushing. This holds regardless of which branch is checked out.
  const remoteHead = captureGitTaskCommand(root, ["rev-parse", `${remote}/${branch}`], {
    check: true,
  });
  const head = captureGitTaskCommand(root, ["rev-parse", "HEAD"], { check: true });
  if (!gitTaskCommandSucceeds(root, ["merge-base", "--is-ancestor", remoteHead, head])) {
    throw new Error(
      `cannot fast-forward ${remote}/${branch} to HEAD; ${branch} has diverged (rebase before release)`,
    );
  }

  runGitTaskCommand(root, ["push", remote, `HEAD:${branch}`]);
  runGitTaskCommand(root, ["tag", "--annotate", tag, "--message", tag]);
  runGitTaskCommand(root, ["push", remote, `refs/tags/${tag}`]);
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

if (import.meta.main) {
  await new Command()
    .option("--root <path>", "repository root")
    .option("--branch <name>", "release branch", "main")
    .option("--prefix <prefix>", "release tag prefix", "v")
    .option("--remote <name>", "git remote", "origin")
    .option("--python-root <path>", "Python package root for local publish", "packages/py")
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
      }) => {
        await runRelease({
          root: options.root ?? projectUtils.root() ?? process.cwd(),
          branch: options.branch,
          bump: options.bump,
          prefix: options.prefix,
          remote: options.remote,
          pythonRoot: options.pythonRoot,
          localPublish: options.localPublish,
        });
      },
    )
    .parseAsync();
}
