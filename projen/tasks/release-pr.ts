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
import * as projectUtils from "@dbx-tools/core/project-utils";
import { asyncUtils, json, log, object } from "@dbx-tools/shared-core";
import { Command } from "commander";
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
  captureGitTaskCommand,
  captureTaskCommand,
  gitTaskCommandSucceeds,
  runGitTaskCommand,
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

function pushCurrentBranch(root: string, branch: string): void {
  runGitTaskCommand(root, ["push", "--set-upstream", "origin", `HEAD:${branch}`]);
}

/** Wait for required checks and return the merged pull request commit. */
async function waitForPullRequestMerge(
  root: string,
  releaseBranch: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const checksDeadline = Date.now() + timeoutMs;
  let checksReported = false;
  while (Date.now() < checksDeadline) {
    const count = Number(
      captureTaskCommand(
        root,
        "gh",
        [
          "pr",
          "view",
          releaseBranch,
          "--json",
          "statusCheckRollup",
          "--jq",
          ".statusCheckRollup | length",
        ],
        { env },
      ),
    );
    if (Number.isInteger(count) && count > 0) {
      checksReported = true;
      break;
    }
    await asyncUtils.sleep(2_000);
  }
  if (!checksReported) {
    throw new Error(`Release pull request reported no checks within ${timeoutMs}ms`);
  }
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
  const status = captureTaskCommand(root, "gh", [
    "auth",
    "status",
    "--hostname",
    identity.hostname,
    "--json",
    "hosts",
  ]);
  const accounts = githubAuthenticatedAccounts(status, identity.hostname);
  for (const account of accounts) {
    if (!githubAccountSupportsWorkflowChanges(account)) continue;
    const token = captureTaskCommand(
      root,
      "gh",
      githubTokenArguments(identity.hostname, account.login),
    );
    if (!token) continue;
    const tokenEnvironment = {
      ...process.env,
      GH_HOST: identity.hostname,
      GH_REPO: githubRepositorySpecifier(identity),
      [githubTokenEnvironmentName(identity.hostname)]: token,
    };
    const repositoryData = json.parseRecord(
      captureTaskCommand(root, "gh", ["api", githubRepositoryApiPath(identity)], {
        env: tokenEnvironment,
      }),
    );
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
  .option("--python-root <path>", "Python package root", "packages/py")
  .option("--message <message>", "commit message for pending source work", "chore: prepare release")
  .addOption(releaseOperatingSystemOption())
  .addOption(releaseArchitectureOption())
  .option("--local-registry <value>", "local npm registry: auto, false, or an explicit URL", "auto")
  .option("--local-pypi <value>", "local PyPI index: auto, false, or an explicit URL", "auto")
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
  .option("--no-approve", "open the release pull request without enabling automatic merge")
  .option("--no-wait", "return after enabling automatic merge without watching publication")
  .option(
    "--wait-timeout-minutes <minutes>",
    "maximum time for pull request checks and merge",
    "120",
  )
  .action(
    async (opts: {
      level: VersionLevel;
      prefix: string;
      base: string;
      pythonRoot: string;
      message: string;
      os: ReleaseOs[];
      arch: ReleaseArch[];
      localRegistry: string;
      localPypi: string;
      validateTask: string[];
      releaseSummary: boolean;
      releaseSummaryProviders?: string;
      validate: boolean;
      localPublish: boolean;
      localCargo: boolean;
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
        if (opts.approve && !opts.wait) {
          throw new Error("automatic merge requires waiting so the draft candidate can be built");
        }
        const currentBranch = captureGitTaskCommand(root, ["branch", "--show-current"], {
          check: true,
        });
        if (!currentBranch) throw new Error("Release preparation requires a local branch");
        const account = githubAccount(root);
        if (!account.canManage) {
          throw new Error("Release preparation requires maintain or admin permission");
        }
        if (hasLocalReleaseTargets(root)) {
          const localTools = missingLocalReleaseTools(root);
          if (localTools.length > 0) {
            throw new Error(`Local release candidate build requires: ${localTools.join(", ")}`);
          }
        }
        runGitTaskCommand(root, ["fetch", "--tags", "origin", opts.base]);
        const comparisonBase = resolveBaseVersion(root);
        const next = resolveNextVersion(root, opts.level);
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
        if (currentBranch.startsWith("release/")) {
          throw new Error("Release preparation must start from a source branch");
        }
        if (
          captureGitTaskCommand(root, ["ls-remote", "--tags", "origin", `refs/tags/${releaseTag}`])
        ) {
          throw new Error(`Release tag already exists: ${releaseTag}`);
        }

        const status = captureGitTaskCommand(
          root,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          { check: true },
        );
        if (status) {
          runGitTaskCommand(root, ["add", "-A"]);
          runGitTaskCommand(root, ["commit", "-m", opts.message]);
        }
        if (
          !gitTaskCommandSucceeds(root, [
            "merge-base",
            "--is-ancestor",
            `origin/${opts.base}`,
            "HEAD",
          ])
        ) {
          runGitTaskCommand(root, ["merge", "--no-edit", `origin/${opts.base}`]);
        }
        pushCurrentBranch(root, currentBranch);
        const localBranch = Boolean(
          captureGitTaskCommand(root, ["branch", "--list", releaseBranch]),
        );
        const remoteBranch = Boolean(
          captureGitTaskCommand(root, [
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${releaseBranch}`,
          ]),
        );
        let releaseCompleted = false;
        try {
          if (localBranch) {
            runGitTaskCommand(root, ["switch", releaseBranch]);
          } else if (remoteBranch) {
            runGitTaskCommand(root, [
              "switch",
              "--track",
              "-c",
              releaseBranch,
              `origin/${releaseBranch}`,
            ]);
          } else {
            runGitTaskCommand(root, ["switch", "-c", releaseBranch]);
          }
          const resumableStash = captureGitTaskCommand(root, [
            "stash",
            "list",
            "--format=%gd%x09%s",
          ])
            .split("\n")
            .find((line) => line.includes(`release-resume:${releaseBranch}`))
            ?.split("\t")[0];
          if (resumableStash) runGitTaskCommand(root, ["stash", "pop", resumableStash]);
          if (
            !gitTaskCommandSucceeds(root, ["merge-base", "--is-ancestor", currentBranch, "HEAD"])
          ) {
            runGitTaskCommand(root, ["merge", "--no-edit", currentBranch]);
          }
          runTaskCommand(root, process.execPath, ["install"]);

          const bumpScript = fileURLToPath(new URL("./bump.ts", import.meta.url));
          const versionCheckScript = fileURLToPath(new URL("./version-check.ts", import.meta.url));
          const preparedVersion = readWorkspaceVersion(root);
          if (preparedVersion !== next.version) {
            if (preparedVersion !== comparisonBase) {
              throw new Error(
                `${releaseBranch} carries ${preparedVersion}; expected ${comparisonBase} or ${next.version}`,
              );
            }
            runTaskCommand(root, process.execPath, [
              bumpScript,
              "--level",
              opts.level,
              ...opts.os.flatMap((value) => ["--os", value]),
              ...opts.arch.flatMap((value) => ["--arch", value]),
            ]);
          } else {
            logger.info(`resuming prepared ${releaseTag}`);
          }
          if (readWorkspaceVersion(root) !== next.version) {
            throw new Error(`Release preparation did not produce ${next.version}`);
          }

          runTaskCommand(root, process.execPath, [versionCheckScript]);
          if (opts.validate) {
            for (const task of opts.validateTask) {
              runTaskCommand(root, process.execPath, ["run", task]);
            }
            if (existsSync(join(root, "Cargo.toml"))) {
              runTaskCommand(root, "cargo", [
                "test",
                "--workspace",
                ...(existsSync(join(root, "Cargo.lock")) ? ["--locked"] : []),
              ]);
            }
            runTaskCommand(root, process.execPath, ["run", "compile"]);
          } else {
            logger.warn("release validation skipped by --no-validate");
          }
          runTaskCommand(root, process.execPath, [versionCheckScript]);
          const releaseSummary = opts.releaseSummary
            ? await generateReleaseSummary({
                root,
                version: next.version,
                fromRef: `${opts.prefix}${comparisonBase}`,
                providers: releaseSummaryProviders(opts.releaseSummaryProviders),
              })
            : undefined;

          runGitTaskCommand(root, ["add", "-A"]);
          const staged = captureGitTaskCommand(root, ["diff", "--cached", "--name-only"], {
            check: true,
          });
          if (staged) {
            runGitTaskCommand(root, ["commit", "-m", `chore(release): ${next.version}`]);
          } else if (!localBranch && !remoteBranch) {
            throw new Error("Release preparation produced no changes");
          }
          runGitTaskCommand(root, ["push", "--set-upstream", "origin", releaseBranch]);

          const title = `chore(release): ${next.version}`;
          const body = [
            `Release ${releaseTag}.`,
            "",
            `Source commit: ${captureGitTaskCommand(root, ["rev-parse", `${releaseBranch}^`], { check: true })}`,
            "",
            "Merging this PR updates VERSION on main and prepares a draft GitHub Release.",
            ...(releaseSummary ? ["", releaseSummary] : []),
          ].join("\n");
          const githubEnvironment = {
            ...process.env,
            GH_HOST: account.hostname,
            GH_REPO: githubRepositorySpecifier(account),
            [githubTokenEnvironmentName(account.hostname)]: account.token,
          };
          if (
            !taskCommandSucceeds(root, "gh", ["pr", "view", releaseBranch], {
              env: githubEnvironment,
            })
          ) {
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
          }
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
            runGitTaskCommand(root, ["fetch", "origin", opts.base]);
            runGitTaskCommand(root, ["switch", "--detach", mergeSha]);
            runTaskCommand(root, process.execPath, ["install"]);
            const releaseCandidateScript = join(
              root,
              "node_modules/@dbx-tools/projen/tasks/release-candidate.ts",
            );
            const candidateArguments = [
              releaseCandidateScript,
              "--root",
              root,
              "--version",
              next.version,
              "--tag",
              releaseTag,
              "--sha",
              mergeSha,
              "--python-root",
              opts.pythonRoot,
              "--notes-file",
              `docs/releases/v${next.version}.md`,
            ];
            runTaskCommand(root, process.execPath, candidateArguments, {
              env: githubEnvironment,
            });
            if (opts.localPublish) {
              const localPublishScript = join(
                root,
                "node_modules/@dbx-tools/projen/tasks/local-publish.ts",
              );
              runTaskCommand(
                root,
                process.execPath,
                [
                  localPublishScript,
                  "--root",
                  root,
                  "--candidate-directory",
                  "dist/release/upload",
                  "--version",
                  next.version,
                  "--tag",
                  releaseTag,
                  "--sha",
                  mergeSha,
                  "--local-registry",
                  opts.localRegistry,
                  "--local-pypi",
                  opts.localPypi,
                  ...(opts.localCargo ? ["--local-cargo"] : []),
                ],
                { env: githubEnvironment },
              );
            } else {
              logger.info("local publication skipped by --no-local-publish");
            }
            runTaskCommand(root, process.execPath, [...candidateArguments, "--upload-existing"], {
              env: githubEnvironment,
            });
            logger.success(`prepared draft ${releaseTag} from ${mergeSha}`);
          } else {
            logger.success(`opened ${releaseBranch} for ${releaseTag}`);
          }
          releaseCompleted = true;
        } finally {
          const activeBranch = captureGitTaskCommand(root, ["branch", "--show-current"]);
          if (activeBranch !== currentBranch) {
            const releaseStatus = captureGitTaskCommand(
              root,
              ["status", "--porcelain=v1", "--untracked-files=all"],
              { check: true },
            );
            if (releaseStatus) {
              runGitTaskCommand(root, [
                "stash",
                "push",
                "--include-untracked",
                "--message",
                `release-resume:${releaseBranch}`,
              ]);
            }
            runGitTaskCommand(root, ["switch", currentBranch]);
          }
          if (
            releaseCompleted &&
            captureGitTaskCommand(root, ["branch", "--list", releaseBranch])
          ) {
            runGitTaskCommand(root, ["branch", "--delete", "--force", releaseBranch]);
          }
        }
      });
    },
  );

if (import.meta.main) await program.parseAsync();
