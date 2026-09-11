#!/usr/bin/env -S bun
/**
 * Prepare a reviewed release pull request from the current branch.
 *
 * Pending work is committed and the current branch is pushed first. A dedicated
 * release branch then receives the VERSION change, generated files, validation,
 * and local registry preflight. Public publication remains owned by the
 * main-branch release workflow.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, project } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { publishLocalRelease } from "./local-publish.ts";
import {
  type VersionLevel,
  readWorkspaceVersion,
  resolveNextVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:release");
const LEVELS = ["patch", "minor", "major"] as const;
const RELEASE_OSES = ["darwin", "linux", "win32"] as const;
const RELEASE_ARCHES = ["arm64", "x64"] as const;
type ReleaseOs = (typeof RELEASE_OSES)[number];
type ReleaseArch = (typeof RELEASE_ARCHES)[number];

function collectValue<T extends string>(value: T, previous: T[]): T[] {
  return [...previous, value];
}

function git(
  root: string,
  args: string[],
  { capture = false, check = true }: { capture?: boolean; check?: boolean } = {},
): string {
  const result = exec.spawnSync("git", args, {
    cwd: root,
    stdout: capture ? "capture" : "inherit",
    stderr: capture ? "ignore" : "inherit",
    stdin: "ignore",
    check,
  });
  return result.stdout?.trim() ?? "";
}

function pushCurrentBranch(root: string, branch: string): void {
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    capture: true,
    check: false,
  });
  git(root, upstream ? ["push"] : ["push", "--set-upstream", "origin", branch]);
}

function gitSucceeds(root: string, args: string[]): boolean {
  return (
    exec.spawnSync("git", args, {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    }).exitCode === 0
  );
}

function commandSucceeds(
  root: string,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): boolean {
  return (
    exec.spawnSync(command, args, {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    }).exitCode === 0
  );
}

function run(root: string, command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  exec.spawnSync(command, args, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
  });
}

function githubAccount(root: string): { owner: string; token: string } {
  const repository = project.repositoryUrl(root);
  if (!repository) throw new Error("Release preparation requires a GitHub repository");
  const owner = new URL(repository).pathname.split("/").filter(Boolean)[0];
  if (!owner) throw new Error(`Cannot determine GitHub owner from ${repository}`);
  const token = exec
    .spawnSync("gh", ["auth", "token", "--user", owner], {
      cwd: root,
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: true,
    })
    .stdout?.trim();
  if (!token) throw new Error(`No GitHub CLI authentication found for ${owner}`);
  return { owner, token };
}

const program = new Command();
program
  .description("Prepare, validate, locally publish, and open a reviewed release PR")
  .addOption(
    new Option("-l, --level <level>", "semver increment").choices([...LEVELS]).default("patch"),
  )
  .option("--prefix <prefix>", "release tag prefix", "v")
  .option("--base <branch>", "release pull request base branch", "main")
  .option("--message <message>", "commit message for pending source work", "chore: prepare release")
  .addOption(
    new Option("--os <os>", "release operating system, repeatable; crossed with every --arch")
      .choices([...RELEASE_OSES])
      .argParser((value, previous: ReleaseOs[]) => collectValue(value as ReleaseOs, previous))
      .default([] as ReleaseOs[]),
  )
  .addOption(
    new Option("--arch <arch>", "release CPU architecture, repeatable; crossed with every --os")
      .choices([...RELEASE_ARCHES])
      .argParser((value, previous: ReleaseArch[]) => collectValue(value as ReleaseArch, previous))
      .default([] as ReleaseArch[]),
  )
  .option("--local-registry <value>", "local npm registry: auto, false, or an explicit URL", "auto")
  .option("--local-pypi <value>", "local PyPI index: auto, false, or an explicit URL", "auto")
  .option("--python-root <path>", "Python workspace package root", "packages/py")
  .option("--no-local-cargo", "skip local Cargo publication")
  .option("--approve", "merge the release PR immediately with admin bypass")
  .action(
    async (opts: {
      level: VersionLevel;
      prefix: string;
      base: string;
      message: string;
      os: ReleaseOs[];
      arch: ReleaseArch[];
      localRegistry: string;
      localPypi: string;
      pythonRoot: string;
      localCargo: boolean;
      approve: boolean;
    }) => {
      const root = project.root() ?? process.cwd();
      const currentBranch = git(root, ["branch", "--show-current"], { capture: true });
      if (!currentBranch) throw new Error("Release preparation requires a local branch");
      const account = githubAccount(root);
      git(root, ["fetch", "--tags", "origin", opts.base]);
      const next = resolveNextVersion(root, [opts.prefix], opts.level, { fetch: false });
      const releaseTag = `${opts.prefix}${next.version}`;
      const releaseBranch = `release/${releaseTag}`;
      const releaseRoot = join(root, ".worktrees", releaseTag);
      if (currentBranch.startsWith("release/")) {
        throw new Error("Release preparation must start from a source branch");
      }
      if (
        git(root, ["ls-remote", "--tags", "origin", `refs/tags/${releaseTag}`], {
          capture: true,
          check: false,
        })
      ) {
        throw new Error(`Release tag already exists: ${releaseTag}`);
      }

      const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
        capture: true,
      });
      if (status) {
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", opts.message]);
      }
      if (!gitSucceeds(root, ["merge-base", "--is-ancestor", `origin/${opts.base}`, "HEAD"])) {
        git(root, ["merge", "--no-edit", `origin/${opts.base}`]);
      }
      pushCurrentBranch(root, currentBranch);

      const worktreeExists = existsSync(join(releaseRoot, ".git"));
      if (!worktreeExists) {
        git(root, ["worktree", "prune"]);
        const localBranch = git(root, ["branch", "--list", releaseBranch], { capture: true });
        const remoteBranch = git(
          root,
          ["ls-remote", "--heads", "origin", `refs/heads/${releaseBranch}`],
          { capture: true, check: false },
        );
        if (localBranch || remoteBranch) {
          throw new Error(`Release branch already exists without its worktree: ${releaseBranch}`);
        }
        git(root, ["worktree", "add", "-b", releaseBranch, releaseRoot, "HEAD"]);
        run(releaseRoot, process.execPath, ["install"]);
      } else {
        logger.info(`resuming ${releaseBranch} in ${releaseRoot}`);
      }

      const bumpScript = fileURLToPath(new URL("./bump.ts", import.meta.url));
      const versionCheckScript = fileURLToPath(new URL("./version-check.ts", import.meta.url));
      run(releaseRoot, process.execPath, [
        bumpScript,
        "--level",
        opts.level,
        "--prefix",
        opts.prefix,
        ...opts.os.flatMap((value) => ["--os", value]),
        ...opts.arch.flatMap((value) => ["--arch", value]),
      ]);
      if (readWorkspaceVersion(releaseRoot) !== next.version) {
        throw new Error(`Release preparation did not produce ${next.version}`);
      }

      run(releaseRoot, process.execPath, [versionCheckScript]);
      if (existsSync(join(releaseRoot, "Cargo.toml"))) {
        run(releaseRoot, "cargo", [
          "test",
          "--workspace",
          ...(existsSync(join(releaseRoot, "Cargo.lock")) ? ["--locked"] : []),
        ]);
        run(releaseRoot, process.execPath, ["run", "rs:bindings"]);
      }
      run(releaseRoot, process.execPath, ["run", "compile"]);
      run(releaseRoot, process.execPath, ["run", "test"]);
      await publishLocalRelease({
        root: releaseRoot,
        version: next.version,
        localRegistry: opts.localRegistry,
        localPypi: opts.localPypi,
        pythonRoot: opts.pythonRoot,
        localCargo: opts.localCargo,
      });
      run(releaseRoot, process.execPath, [versionCheckScript]);

      git(releaseRoot, ["add", "-A"]);
      const staged = git(releaseRoot, ["diff", "--cached", "--name-only"], { capture: true });
      if (staged) {
        git(releaseRoot, ["commit", "-m", `chore(release): ${next.version}`]);
      } else if (!worktreeExists) {
        throw new Error("Release preparation produced no changes");
      }
      git(releaseRoot, ["push", "--set-upstream", "origin", releaseBranch]);

      const title = `chore(release): ${next.version}`;
      const body = [
        `Release ${releaseTag}.`,
        "",
        `Source commit: ${git(releaseRoot, ["rev-parse", `${releaseBranch}^`], { capture: true })}`,
        "",
        "Merging this PR updates VERSION on main and starts the public release workflow.",
      ].join("\n");
      const githubEnvironment = { ...process.env, GH_TOKEN: account.token };
      if (!commandSucceeds(root, "gh", ["pr", "view", releaseBranch], githubEnvironment)) {
        run(
          root,
          "gh",
          [
            "pr",
            "create",
            "--base",
            opts.base,
            "--head",
            releaseBranch,
            "--title",
            title,
            "--body",
            body,
          ],
          githubEnvironment,
        );
      }
      if (opts.approve) {
        run(root, "gh", ["pr", "merge", releaseBranch, "--admin", "--merge"], githubEnvironment);
      }
      git(root, ["worktree", "remove", "--force", releaseRoot]);
      git(root, ["branch", "--delete", "--force", releaseBranch]);
      logger.success(`${opts.approve ? "merged" : "opened"} ${releaseBranch} for ${releaseTag}`);
    },
  );

await program.parseAsync();
