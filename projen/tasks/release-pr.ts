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
import * as exec from "@dbx-tools/core/exec";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { asyncUtils, json, log, object } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { publishLocalRelease } from "./local-publish.ts";
import { hasLocalReleaseTargets, missingLocalReleaseTools } from "./release-assets.ts";
import { generateReleaseSummary } from "./release-summary.ts";
import {
  releaseArchitectureOption,
  releaseLevelOption,
  releaseOperatingSystemOption,
  type ReleaseArch,
  type ReleaseOs,
  type VersionLevel,
} from "../src/_release-platform.ts";
import {
  captureTaskCommand,
  runTaskCommand,
  runTaskCommandAsync,
  taskCommandSucceeds,
} from "../src/_task-command.ts";
import {
  RELEASE_SUMMARY_PROVIDER_NAMES,
  type ReleaseSummaryProviderName,
} from "../src/release-dispatch.ts";
import {
  githubAccountSupportsWorkflowChanges,
  githubAuthenticatedAccounts,
  githubRepositoryApiPath,
  githubRepositoryCanManage,
  githubRepositoryIdentity,
  githubRepositoryPermissions,
  githubRepositorySpecifier,
  githubTokenArguments,
  githubTokenEnvironmentName,
} from "../src/release-github.ts";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";
import {
  readWorkspaceVersion,
  resolveBaseVersion,
  resolveNextVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:release");

export type ReleaseBuildMode = "auto" | "local" | "remote";

/** Resolve an explicit or environment-sensitive native release build mode. */
export function resolveReleaseBuildMode(options: {
  readonly requested: ReleaseBuildMode;
  readonly canManage: boolean;
  readonly localTools: readonly string[];
  readonly hasLocalTargets: boolean;
  readonly approve: boolean;
  readonly wait: boolean;
  readonly hostPlatform?: NodeJS.Platform;
}): Exclude<ReleaseBuildMode, "auto"> {
  const local =
    options.canManage &&
    options.hasLocalTargets &&
    (options.hostPlatform ?? process.platform) === "darwin" &&
    options.localTools.length === 0 &&
    options.approve &&
    options.wait;
  if (options.requested === "auto") return local ? "local" : "remote";
  if (options.requested === "remote") return "remote";
  if (!options.canManage) throw new Error("--build local requires maintain or admin permission");
  if (!options.hasLocalTargets) throw new Error("--build local requires Rust release targets");
  if ((options.hostPlatform ?? process.platform) !== "darwin") {
    throw new Error("--build local requires macOS");
  }
  if (options.localTools.length > 0) {
    throw new Error(`--build local requires: ${options.localTools.join(", ")}`);
  }
  if (!options.approve || !options.wait) {
    throw new Error("--build local requires automatic merge and waiting");
  }
  return "local";
}

function git(
  root: string,
  args: string[],
  { capture = false, check = true }: { capture?: boolean; check?: boolean } = {},
): string {
  if (capture) return captureTaskCommand(root, "git", args, { check });
  runTaskCommand(root, "git", args);
  return "";
}

function pushCurrentBranch(root: string, branch: string): void {
  git(root, ["push", "--set-upstream", "origin", `HEAD:${branch}`]);
}

function gitSucceeds(root: string, args: string[]): boolean {
  return taskCommandSucceeds(root, "git", args);
}

/** Wait for required checks and return the merged pull request commit. */
async function waitForPullRequestMerge(
  root: string,
  releaseBranch: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  await runTaskCommandAsync(
    root,
    "gh",
    ["pr", "checks", releaseBranch, "--watch", "--fail-fast", "--required", "--interval", "10"],
    { env, signal: AbortSignal.timeout(timeoutMs) },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = captureTaskCommand(
      root,
      "gh",
      [
        "pr",
        "view",
        releaseBranch,
        "--json",
        "state,mergeCommit",
        "--jq",
        '[.state, (.mergeCommit.oid // "")] | @tsv',
      ],
      { env },
    );
    const [status, mergeSha] = state.split("\t");
    if (status === "MERGED" && mergeSha) return mergeSha;
    if (status === "CLOSED") throw new Error(`Release pull request closed without merging`);
    await asyncUtils.sleep(2_000);
  }
  throw new Error(`Release pull request did not merge within ${timeoutMs}ms`);
}

/** Find and watch the release workflow for an exact merged commit. */
async function waitForReleaseWorkflow(
  root: string,
  baseBranch: string,
  mergeSha: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let runId = "";
  while (Date.now() < deadline) {
    runId = captureTaskCommand(
      root,
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "release.yml",
        "--branch",
        baseBranch,
        "--event",
        "push",
        "--commit",
        mergeSha,
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId // empty",
      ],
      { env },
    );
    if (runId) break;
    await asyncUtils.sleep(5_000);
  }
  if (!runId) throw new Error(`Release workflow did not start within ${timeoutMs}ms`);
  await runTaskCommandAsync(root, "gh", ["run", "watch", runId, "--exit-status"], {
    env,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function waitForGitHubRelease(
  root: string,
  tag: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (taskCommandSucceeds(root, "gh", ["release", "view", tag], { env })) return;
    await asyncUtils.sleep(2_000);
  }
  throw new Error(`GitHub Release ${tag} did not appear within ${timeoutMs}ms`);
}

function githubAccount(root: string): {
  hostname: string;
  owner: string;
  repository: string;
  login: string;
  token: string;
  canManage: boolean;
} {
  const repository = projectUtils.repositoryUrl(root);
  if (!repository) throw new Error("Release preparation requires a GitHub repository");
  const identity = githubRepositoryIdentity(repository);
  const status = exec
    .spawnSync("gh", ["auth", "status", "--hostname", identity.hostname, "--json", "hosts"], {
      cwd: root,
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    })
    .stdout?.trim();
  const accounts = githubAuthenticatedAccounts(status ?? "", identity.hostname);
  for (const account of accounts) {
    if (!githubAccountSupportsWorkflowChanges(account)) continue;
    const token = exec
      .spawnSync("gh", githubTokenArguments(identity.hostname, account.login), {
        cwd: root,
        stdout: "capture",
        stderr: "ignore",
        stdin: "ignore",
        check: false,
      })
      .stdout?.trim();
    if (!token) continue;
    const tokenEnvironment = {
      ...process.env,
      GH_HOST: identity.hostname,
      GH_REPO: githubRepositorySpecifier(identity),
      [githubTokenEnvironmentName(identity.hostname)]: token,
    };
    const repositoryResult = exec.spawnSync("gh", ["api", githubRepositoryApiPath(identity)], {
      cwd: root,
      env: tokenEnvironment,
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    });
    const repositoryData =
      repositoryResult.exitCode === 0 ? json.parseRecord(repositoryResult.stdout ?? "") : undefined;
    const permissions = githubRepositoryPermissions(repositoryData);
    if (!permissions.push && !permissions.maintain && !permissions.admin) {
      continue;
    }
    logger.info("selected GitHub CLI account", {
      login: account.login,
      repository: `${identity.owner}/${identity.repository}`,
    });
    return {
      ...identity,
      login: account.login,
      token,
      canManage: githubRepositoryCanManage(permissions),
    };
  }
  const detected =
    accounts
      .map((account) => {
        const workflow = githubAccountSupportsWorkflowChanges(account)
          ? "workflow-capable"
          : "missing workflow scope";
        return `${account.login} (${workflow})`;
      })
      .join(", ") || "none";
  throw new Error(
    `No authenticated GitHub CLI account can write release workflow changes to ${identity.owner}/${identity.repository} on ${identity.hostname}; detected accounts: ${detected}`,
  );
}

function releaseSummaryProviders(
  value: string | undefined,
): ReleaseSummaryProviderName[] | undefined {
  if (value === undefined) return undefined;
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  for (const provider of providers) {
    if (!RELEASE_SUMMARY_PROVIDER_NAMES.includes(provider as ReleaseSummaryProviderName)) {
      throw new Error(`Unknown release summary provider: ${provider}`);
    }
  }
  return providers as ReleaseSummaryProviderName[];
}

const program = new Command();
program
  .description("Prepare, validate, locally publish, and open a reviewed release PR")
  .addOption(releaseLevelOption())
  .option("--prefix <prefix>", "release tag prefix", "v")
  .option("--base <branch>", "release pull request base branch", "main")
  .option("--message <message>", "commit message for pending source work", "chore: prepare release")
  .addOption(releaseOperatingSystemOption())
  .addOption(releaseArchitectureOption())
  .option("--local-registry <value>", "local npm registry: auto, false, or an explicit URL", "auto")
  .option("--local-pypi <value>", "local PyPI index: auto, false, or an explicit URL", "auto")
  .option("--python-root <path>", "Python workspace package root")
  .option(
    "--validate-task <task>",
    "repository task to run before release validation; repeatable",
    (task: string, tasks: string[]) => [...tasks, task],
    [],
  )
  .option("--no-release-summary", "skip optional AI release summary generation")
  .option(
    "--release-summary-providers <providers>",
    "comma-separated provider order: cursor,codex,claude",
  )
  .option("--no-validate", "skip repository validation tasks, Rust tests, and TypeScript compile")
  .option("--no-local-publish", "skip local npm, PyPI, and Cargo publication")
  .option("--no-local-cargo", "skip local Cargo publication")
  .option("--build <mode>", "native release build: auto, local, or remote", "auto")
  .option("--no-approve", "open the release pull request without enabling automatic merge")
  .option("--no-wait", "return after enabling automatic merge without watching publication")
  .option(
    "--wait-timeout-minutes <minutes>",
    "maximum time for pull request checks, merge, and publication",
    "120",
  )
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
      pythonRoot?: string;
      validateTask: string[];
      releaseSummary: boolean;
      releaseSummaryProviders?: string;
      validate: boolean;
      localPublish: boolean;
      localCargo: boolean;
      build: ReleaseBuildMode;
      approve: boolean;
      wait: boolean;
      waitTimeoutMinutes: string;
    }) => {
      const root = projectUtils.root() ?? process.cwd();
      await withWorkspaceMutationLock(root, async () => {
        const waitTimeoutMinutes = object.toNumber(opts.waitTimeoutMinutes, {
          separators: false,
          percent: false,
        });
        if (
          waitTimeoutMinutes === undefined ||
          !Number.isInteger(waitTimeoutMinutes) ||
          waitTimeoutMinutes <= 0
        ) {
          throw new Error("--wait-timeout-minutes must be a positive integer");
        }
        const waitTimeoutMs = waitTimeoutMinutes * 60_000;
        const currentBranch = git(root, ["branch", "--show-current"], { capture: true });
        if (!currentBranch) throw new Error("Release preparation requires a local branch");
        const account = githubAccount(root);
        if (!["auto", "local", "remote"].includes(opts.build)) {
          throw new Error("--build must be auto, local, or remote");
        }
        const inspectLocalTools =
          opts.build === "local" || (opts.build === "auto" && account.canManage);
        const localTools = inspectLocalTools ? missingLocalReleaseTools(root) : [];
        const buildMode = resolveReleaseBuildMode({
          requested: opts.build,
          canManage: account.canManage,
          localTools,
          hasLocalTargets: hasLocalReleaseTargets(root),
          approve: opts.approve,
          wait: opts.wait,
        });
        logger.info("selected native release build", {
          requested: opts.build,
          resolved: buildMode,
          manager: account.canManage,
          ...(localTools.length > 0 ? { missing: localTools } : {}),
        });
        git(root, ["fetch", "--tags", "origin", opts.base]);
        const comparisonBase = resolveBaseVersion(root, [opts.prefix], {
          fetch: false,
          includeComponentTags: false,
        }).version;
        const next = resolveNextVersion(root, [opts.prefix], opts.level, { fetch: false });
        const releaseVersionScript = fileURLToPath(
          new URL("./release-version.ts", import.meta.url),
        );
        runTaskCommand(root, process.execPath, [
          releaseVersionScript,
          "--version",
          next.version,
          "--prefix",
          opts.prefix,
          "--assert-next",
        ]);
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
        } else {
          const releaseStatus = git(
            releaseRoot,
            ["status", "--porcelain=v1", "--untracked-files=all"],
            { capture: true },
          );
          if (releaseStatus) {
            git(releaseRoot, [
              "stash",
              "push",
              "--include-untracked",
              "--message",
              "release-resume",
            ]);
          }
          if (!gitSucceeds(releaseRoot, ["merge-base", "--is-ancestor", currentBranch, "HEAD"])) {
            git(releaseRoot, ["merge", "--no-edit", currentBranch]);
          }
          if (releaseStatus) {
            git(releaseRoot, ["stash", "pop"]);
          }
          logger.info(`resuming ${releaseBranch} in ${releaseRoot}`);
        }
        runTaskCommand(releaseRoot, process.execPath, ["install"]);

        const bumpScript = fileURLToPath(new URL("./bump.ts", import.meta.url));
        const versionCheckScript = fileURLToPath(new URL("./version-check.ts", import.meta.url));
        runTaskCommand(releaseRoot, process.execPath, [
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

        runTaskCommand(releaseRoot, process.execPath, [versionCheckScript]);
        if (opts.validate) {
          for (const task of opts.validateTask) {
            runTaskCommand(releaseRoot, process.execPath, ["run", task]);
          }
          if (existsSync(join(releaseRoot, "Cargo.toml"))) {
            runTaskCommand(releaseRoot, "cargo", [
              "test",
              "--workspace",
              ...(existsSync(join(releaseRoot, "Cargo.lock")) ? ["--locked"] : []),
            ]);
          }
          runTaskCommand(releaseRoot, process.execPath, ["run", "compile"]);
        } else {
          logger.warn("release validation skipped by --no-validate");
        }
        if (opts.localPublish) {
          await publishLocalRelease({
            root: releaseRoot,
            version: next.version,
            localRegistry: opts.localRegistry,
            localPypi: opts.localPypi,
            pythonRoot: opts.pythonRoot,
            localCargo: opts.localCargo,
            reuseValidatedNodeCompile: opts.validate,
          });
        } else {
          logger.info("local publication skipped by --no-local-publish");
        }
        runTaskCommand(releaseRoot, process.execPath, [versionCheckScript]);
        const releaseSummary = opts.releaseSummary
          ? await generateReleaseSummary({
              root: releaseRoot,
              version: next.version,
              fromRef: `${opts.prefix}${comparisonBase}`,
              providers: releaseSummaryProviders(opts.releaseSummaryProviders),
            })
          : undefined;

        git(releaseRoot, ["add", "-A"]);
        const staged = git(releaseRoot, ["diff", "--cached", "--name-only"], { capture: true });
        if (staged) {
          git(releaseRoot, [
            "commit",
            "-m",
            `chore(release): ${next.version}`,
            "-m",
            `Release-Build: ${buildMode}`,
          ]);
        } else if (!worktreeExists) {
          throw new Error("Release preparation produced no changes");
        }
        // The source push and release commit hooks have already scanned every new
        // byte. A new remote branch has no upstream comparison point, so the
        // managed pre-push hook would rescan the repository's complete history.
        git(releaseRoot, ["push", "--no-verify", "--set-upstream", "origin", releaseBranch]);

        const title = `chore(release): ${next.version}`;
        const body = [
          `Release ${releaseTag}.`,
          "",
          `Source commit: ${git(releaseRoot, ["rev-parse", `${releaseBranch}^`], { capture: true })}`,
          "",
          "Merging this PR updates VERSION on main and starts the public release workflow.",
          "",
          `Native build: ${buildMode}.`,
          ...(releaseSummary ? ["", releaseSummary] : []),
        ].join("\n");
        const githubEnvironment = {
          ...process.env,
          GH_HOST: account.hostname,
          GH_REPO: githubRepositorySpecifier(account),
          [githubTokenEnvironmentName(account.hostname)]: account.token,
        };
        const ensurePullRequest = (): void => {
          if (
            taskCommandSucceeds(root, "gh", ["pr", "view", releaseBranch], {
              env: githubEnvironment,
            })
          ) {
            return;
          }
          runTaskCommand(
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
            { env: githubEnvironment },
          );
        };
        ensurePullRequest();
        if (opts.approve) {
          runTaskCommand(root, "gh", ["pr", "merge", releaseBranch, "--auto", "--merge"], {
            env: githubEnvironment,
          });
        }
        if (opts.approve && opts.wait) {
          const mergeSha = await waitForPullRequestMerge(
            root,
            releaseBranch,
            githubEnvironment,
            waitTimeoutMs,
          );
          logger.info("release pull request merged", { releaseBranch, mergeSha });
          if (buildMode === "local") {
            git(root, ["fetch", "origin", opts.base]);
            git(releaseRoot, ["switch", "--detach", mergeSha]);
            runTaskCommand(releaseRoot, process.execPath, ["install"]);
            await waitForGitHubRelease(root, releaseTag, githubEnvironment, waitTimeoutMs);
            const releaseAssetsScript = join(
              releaseRoot,
              "node_modules/@dbx-tools/projen/tasks/release-assets.ts",
            );
            runTaskCommand(
              releaseRoot,
              process.execPath,
              [
                releaseAssetsScript,
                "--root",
                releaseRoot,
                "--version",
                next.version,
                "--tag",
                releaseTag,
                "--upload",
              ],
              { env: githubEnvironment },
            );
          }
          git(root, ["worktree", "remove", "--force", releaseRoot]);
          git(root, ["branch", "--delete", "--force", releaseBranch]);
          await waitForReleaseWorkflow(root, opts.base, mergeSha, githubEnvironment, waitTimeoutMs);
          logger.success(`published ${releaseTag} from ${mergeSha}`);
          return;
        }
        git(root, ["worktree", "remove", "--force", releaseRoot]);
        git(root, ["branch", "--delete", "--force", releaseBranch]);
        logger.success(
          `${
            opts.approve ? "enabled automatic merge for" : "opened"
          } ${releaseBranch} for ${releaseTag}${opts.approve && !opts.wait ? " without waiting" : ""}`,
        );
      });
    },
  );

if (import.meta.main) await program.parseAsync();
