#!/usr/bin/env -S bun
/**
 * Prepare a reviewed release pull request from the current branch.
 *
 * Pending work is committed and the current branch is pushed first. A dedicated
 * release branch then receives the VERSION change, generated files, validation,
 * and local registry preflight. Public publication remains owned by the
 * main-branch release workflow.
 */
import { fileURLToPath } from "node:url";
import { exec, project } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import {
  type VersionLevel,
  readWorkspaceVersion,
  resolveNextVersion,
} from "../src/workspace-version.ts";
import { publishLocalRelease } from "./local-publish.ts";

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

function run(root: string, command: string, args: string[]): void {
  exec.spawnSync(command, args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
  });
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
    }) => {
      const root = project.root() ?? process.cwd();
      const sourceBranch = git(root, ["branch", "--show-current"], { capture: true });
      if (!sourceBranch) throw new Error("Release preparation requires a local branch");
      if (sourceBranch.startsWith("release/")) {
        throw new Error("Release preparation must start from a source branch");
      }
      run(root, "gh", ["auth", "status"]);

      git(root, ["fetch", "--tags", "origin", opts.base]);
      if (!gitSucceeds(root, ["merge-base", "--is-ancestor", `origin/${opts.base}`, "HEAD"])) {
        throw new Error(`Current branch must contain origin/${opts.base}`);
      }
      const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
        capture: true,
      });
      if (status) {
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", opts.message]);
      }
      pushCurrentBranch(root, sourceBranch);

      const next = resolveNextVersion(root, [opts.prefix], opts.level, { fetch: false });
      const releaseTag = `${opts.prefix}${next.version}`;
      const releaseBranch = `release/${releaseTag}`;
      const localBranch = git(root, ["branch", "--list", releaseBranch], { capture: true });
      const remoteBranch = git(
        root,
        ["ls-remote", "--heads", "origin", `refs/heads/${releaseBranch}`],
        { capture: true, check: false },
      );
      if (localBranch || remoteBranch) {
        throw new Error(`Release branch already exists: ${releaseBranch}`);
      }
      if (
        git(root, ["ls-remote", "--tags", "origin", `refs/tags/${releaseTag}`], {
          capture: true,
          check: false,
        })
      ) {
        throw new Error(`Release tag already exists: ${releaseTag}`);
      }

      git(root, ["switch", "--create", releaseBranch]);
      const bumpScript = fileURLToPath(new URL("./bump.ts", import.meta.url));
      const versionCheckScript = fileURLToPath(new URL("./version-check.ts", import.meta.url));
      run(root, process.execPath, [
        bumpScript,
        "--level",
        opts.level,
        "--prefix",
        opts.prefix,
        ...opts.os.flatMap((value) => ["--os", value]),
        ...opts.arch.flatMap((value) => ["--arch", value]),
      ]);
      if (readWorkspaceVersion(root) !== next.version) {
        throw new Error(`Release preparation did not produce ${next.version}`);
      }

      run(root, process.execPath, [versionCheckScript]);
      run(root, process.execPath, ["run", "compile"]);
      run(root, process.execPath, ["run", "test"]);
      await publishLocalRelease({
        root,
        version: next.version,
        localRegistry: opts.localRegistry,
        localPypi: opts.localPypi,
        pythonRoot: opts.pythonRoot,
        localCargo: opts.localCargo,
      });
      run(root, process.execPath, [versionCheckScript]);

      git(root, ["add", "-A"]);
      const staged = git(root, ["diff", "--cached", "--name-only"], { capture: true });
      if (!staged) throw new Error("Release preparation produced no changes");
      git(root, ["commit", "-m", `chore(release): ${next.version}`]);
      git(root, ["push", "--set-upstream", "origin", releaseBranch]);

      const title = `chore(release): ${next.version}`;
      const body = [
        `Release ${releaseTag}.`,
        "",
        `Source branch: ${sourceBranch}`,
        `Source commit: ${git(root, ["rev-parse", `${releaseBranch}^`], { capture: true })}`,
        "",
        "Merging this PR updates VERSION on main and starts the public release workflow.",
      ].join("\n");
      run(root, "gh", [
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
      ]);
      git(root, ["switch", sourceBranch]);
      logger.success(`opened ${releaseBranch} for ${releaseTag}`);
    },
  );

await program.parseAsync();
