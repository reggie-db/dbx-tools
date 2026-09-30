#!/usr/bin/env -S bun
/** Run Release Please with the generated cross-language release-unit plugin. */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { GitHub } from "release-please";
import { Manifest } from "release-please/build/src/manifest.js";
import type { Scm } from "release-please/build/src/scm.js";
import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { addReleaseUnitPlugin } from "../src/release-please.ts";

const logger = log.logger("projen:release-please");

export interface ReleasePleaseRunOptions {
  readonly github: Scm;
  readonly targetBranch: string;
  readonly graph: ReleaseUnitGraph;
  readonly configFile?: string;
  readonly manifestFile?: string;
}

/** Create component releases and refresh the combined release pull request. */
export async function runReleasePlease(options: ReleasePleaseRunOptions) {
  const configFile = options.configFile ?? "release-please-config.json";
  const manifestFile = options.manifestFile ?? ".release-please-manifest.json";
  const manifest = await Manifest.fromManifest(
    options.github,
    options.targetBranch,
    configFile,
    manifestFile,
  );
  addReleaseUnitPlugin(
    manifest.plugins,
    options.github,
    options.targetBranch,
    manifest.repositoryConfig,
    options.graph,
    manifestFile,
  );
  const releases = (await manifest.createReleases()).filter(
    (release): release is NonNullable<typeof release> => release !== undefined,
  );
  const pullRequests = (await manifest.createPullRequests()).filter(
    (pullRequest): pullRequest is NonNullable<typeof pullRequest> => pullRequest !== undefined,
  );
  return { releases, pullRequests };
}

function writeOutput(name: string, value: unknown): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${name}=${JSON.stringify(value)}\n`);
}

/** Parse GitHub owner and repository from HTTPS, SSH, or SSH-alias syntax. */
export function parseGitHubRepository(remote: string): { owner: string; repo: string } {
  const location = remote
    .replace(/^git@[^:]+:/, "")
    .replace(/^ssh:\/\/git@[^/]+\//, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "");
  const [owner, repo, ...extra] = location.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`Could not resolve GitHub repository from ${remote}`);
  }
  return { owner, repo };
}

/** Resolve GitHub owner and repository from environment or the configured remote. */
export function repositoryCoordinates(root: string): { owner: string; repo: string } {
  const configured = process.env.GITHUB_REPOSITORY;
  const remote = configured
    ? configured
    : (exec
        .spawnSync("git", ["remote", "get-url", "origin"], {
          cwd: root,
          stdout: "capture",
          stderr: "ignore",
          stdin: "ignore",
          check: true,
        })
        .stdout?.trim() ?? "");
  return parseGitHubRepository(remote);
}

function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return (
    exec
      .spawnSync("gh", ["auth", "token"], {
        stdout: "capture",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      })
      .stdout?.trim() ?? ""
  );
}

if (import.meta.main) {
  await new Command()
    .option("--owner <owner>", "GitHub repository owner")
    .option("--repo <repo>", "GitHub repository name")
    .option("--target-branch <branch>", "release target branch", "main")
    .option("--root <path>", "repository root", ".")
    .option("--config-file <path>", "Release Please config", "release-please-config.json")
    .option(
      "--manifest-file <path>",
      "Release Please version manifest",
      ".release-please-manifest.json",
    )
    .option("--approve", "compatibility alias for the Release Please release pass")
    .action(
      async (options: {
        owner?: string;
        repo?: string;
        targetBranch: string;
        root: string;
        configFile: string;
        manifestFile: string;
      }) => {
        const root = resolve(options.root);
        const repository =
          options.owner && options.repo
            ? { owner: options.owner, repo: options.repo }
            : repositoryCoordinates(root);
        const graph = JSON.parse(
          readFileSync(resolve(root, ".projen/release-units.json"), "utf8"),
        ) as ReleaseUnitGraph;
        const github = await GitHub.create({
          owner: repository.owner,
          repo: repository.repo,
          defaultBranch: options.targetBranch,
          token: githubToken(),
          ...(process.env.GITHUB_API_URL ? { apiUrl: process.env.GITHUB_API_URL } : {}),
          ...(process.env.GITHUB_GRAPHQL_URL
            ? {
                graphqlUrl: process.env.GITHUB_GRAPHQL_URL.replace(/\/graphql\/?$/, ""),
              }
            : {}),
        });
        const result = await runReleasePlease({
          github,
          targetBranch: options.targetBranch,
          graph,
          configFile: options.configFile,
          manifestFile: options.manifestFile,
        });
        logger.success("release state refreshed", {
          releases: result.releases.length,
          pullRequests: result.pullRequests.length,
        });
        writeOutput("releases_created", result.releases.length > 0);
        writeOutput("prs_created", result.pullRequests.length > 0);
        writeOutput("releases", result.releases);
        writeOutput("prs", result.pullRequests);
      },
    )
    .parseAsync();
}
