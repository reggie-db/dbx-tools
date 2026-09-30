#!/usr/bin/env -S bun
/** Commit and push a source branch for the generated release-request workflow. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { log, string } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { selectReleaseSummary } from "./release-summary.ts";

const logger = log.logger("projen:release-request");

export interface PrepareReleaseRequestOptions {
  readonly root: string;
  readonly baseBranch: string;
  readonly message?: string;
  readonly notes?: string;
  readonly notesFile?: string;
  readonly push?: boolean;
  readonly synthesize?: boolean;
  readonly generateNotes?: (root: string, range: string) => Promise<string>;
}

/** Commit real changes, attach notes to one request commit, and push the branch. */
export async function prepareReleaseRequest(
  options: PrepareReleaseRequestOptions,
): Promise<boolean> {
  const root = resolve(options.root);
  const branch = capture(root, ["branch", "--show-current"]);
  if (!branch) throw new Error("Release requests require a named source branch");
  if (options.push !== false) {
    run(root, ["fetch", "origin", options.baseBranch]);
  }
  const baseRef = options.push === false ? options.baseBranch : `origin/${options.baseBranch}`;
  if (options.synthesize !== false) {
    exec.spawnSync(process.execPath, ["x", "projen"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
  }
  const dirty = capture(root, ["status", "--porcelain"]);
  if (dirty) {
    const message = options.message ?? "fix: prepare release";
    if (!isReleasableMessage(message)) {
      throw new Error("Release commit message must use fix, feat, or a breaking-change marker");
    }
    run(root, ["add", "-A"]);
    run(root, ["commit", "-m", message]);
  }
  const ahead = Number(capture(root, ["rev-list", "--count", `${baseRef}..HEAD`]));
  if (!Number.isInteger(ahead) || ahead < 1) {
    logger.info("no changes from release base; skipping release request", {
      branch,
      base: options.baseBranch,
    });
    return false;
  }
  const messages = capture(root, ["log", "--format=%B%x00", `${baseRef}..HEAD`]);
  if (!messages.split("\0").some(isReleasableMessage)) {
    logger.info("branch has no releasable conventional commits; skipping release request", {
      branch,
    });
    return false;
  }
  const latest = capture(root, ["log", "-1", "--format=%B"]);
  if (/^Release-Request:\s*true$/m.test(latest)) {
    const notesPath = latest.match(/^Release-Notes-Path:\s*(.+)$/m)?.[1]?.trim();
    if (options.push !== false && notesPath) {
      run(root, ["push", "--set-upstream", "origin", branch]);
      const pullRequest = upsertReleasePullRequest(root, branch, options.baseBranch, notesPath);
      dispatchReleaseMerge(root, branch, options.baseBranch, pullRequest);
    }
    logger.info("release request already exists at branch head", { branch });
    return false;
  }
  if (branch === options.baseBranch) {
    throw new Error(`Release requests must run from a branch other than ${options.baseBranch}`);
  }

  const customNotes = string.trimToNull(
    options.notesFile ? readFileSync(resolve(root, options.notesFile), "utf8") : options.notes,
  );
  const notes =
    customNotes ??
    (await (options.generateNotes ?? generateRequestNotes)(root, `${baseRef}..HEAD`));
  const notesPath = `.release-notes/requests/${branch.replace(/[^a-zA-Z0-9-]+/g, "-")}.md`;
  const absoluteNotesPath = resolve(root, notesPath);
  mkdirSync(dirname(absoluteNotesPath), { recursive: true });
  writeFileSync(absoluteNotesPath, `# Release request: ${branch}\n\n${notes.trim()}\n`);
  run(root, ["add", notesPath]);
  run(root, [
    "commit",
    "-m",
    "chore: request release",
    "-m",
    [
      "Release-Request: true",
      `Release-Source-Branch: ${branch}`,
      `Release-Notes-Path: ${notesPath}`,
    ].join("\n"),
  ]);
  if (options.push !== false) {
    run(root, ["push", "--set-upstream", "origin", branch]);
    const pullRequest = upsertReleasePullRequest(root, branch, options.baseBranch, notesPath);
    dispatchReleaseMerge(root, branch, options.baseBranch, pullRequest);
  }
  logger.success("release request pushed", { branch });
  return true;
}

/** Whether one conventional commit can produce a Release Please increment. */
export function isReleasableMessage(message: string): boolean {
  return (
    /^(?:fix|feat)(?:\([^)\r\n]+\))?!?:/m.test(message) || /^BREAKING[ -]CHANGE:/m.test(message)
  );
}

async function generateRequestNotes(root: string, range: string): Promise<string> {
  const commits = capture(root, ["log", "--no-merges", "--format=%s%n%b", range]);
  const files = capture(root, ["diff", "--name-status", range, "--", "."]);
  const result = await selectReleaseSummary(
    root,
    [
      "Write concise release-request notes for the reviewed changes below.",
      "Focus on user-visible behavior and important compatibility details.",
      "",
      "Commits:",
      commits,
      "",
      "Files:",
      files,
    ].join("\n"),
  );
  if (result?.summary.trim()) return result.summary.trim();
  const subjects = capture(root, ["log", "--no-merges", "--format=- %s", range]);
  return subjects || "Release source changes are ready for review.";
}

/** Create or refresh the source pull request with the local GitHub identity. */
function upsertReleasePullRequest(
  root: string,
  branch: string,
  baseBranch: string,
  notesPath: string,
): string {
  const title = capture(root, ["log", "-1", "--skip=1", "--format=%s"]);
  const notes = readFileSync(resolve(root, notesPath), "utf8").trim();
  const body = `## Release notes\n\n${notes}\n`;
  const pullRequest = findReleasePullRequest(root, branch, baseBranch);
  if (pullRequest) {
    runCommand(root, "gh", ["pr", "edit", pullRequest, "--title", title, "--body", body]);
    return pullRequest;
  }
  runCommand(root, "gh", [
    "pr",
    "create",
    "--head",
    branch,
    "--base",
    baseBranch,
    "--title",
    title,
    "--body",
    body,
  ]);
  const created = findReleasePullRequest(root, branch, baseBranch);
  if (!created) throw new Error(`Could not resolve the pull request for ${branch}`);
  return created;
}

/** Find the open source pull request for a release branch. */
function findReleasePullRequest(root: string, branch: string, baseBranch: string): string {
  return captureCommand(root, "gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    baseBranch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
}

/** Ask the repository workflow to merge the reviewed source and start release planning. */
function dispatchReleaseMerge(
  root: string,
  branch: string,
  baseBranch: string,
  pullRequest: string,
): void {
  runCommand(root, "gh", [
    "workflow",
    "run",
    "release-request.yml",
    "--ref",
    branch,
    "-f",
    `pull_request=${pullRequest}`,
    "-f",
    `base_branch=${baseBranch}`,
  ]);
}

function capture(root: string, args: string[]): string {
  return captureCommand(root, "git", args);
}

/** Run a command and return its trimmed standard output. */
function captureCommand(root: string, command: string, args: string[]): string {
  return (
    exec
      .spawnSync(command, args, {
        cwd: root,
        stdout: "capture",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      })
      .stdout?.trim() ?? ""
  );
}

function run(root: string, args: string[]): void {
  runCommand(root, "git", args);
}

/** Run a command with inherited output and fail on a nonzero exit. */
function runCommand(root: string, command: string, args: string[]): void {
  exec.spawnSync(command, args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    check: true,
  });
}

/** Restore option text after Projen forwards task arguments without shell quoting. */
function optionText(values?: readonly string[]): string | undefined {
  return values?.join(" ");
}

if (import.meta.main) {
  await new Command()
    .option("--base <branch>", "release target branch", "main")
    .option("--message <message...>", "commit message for uncommitted source changes")
    .option("--notes <notes...>", "custom release notes")
    .option("--notes-file <path>", "read custom release notes from a file")
    .action(
      async (options: {
        base: string;
        message?: string[];
        notes?: string[];
        notesFile?: string;
      }) => {
        if (options.notes && options.notesFile) {
          throw new Error("Use --notes or --notes-file, not both");
        }
        await prepareReleaseRequest({
          root: project.root() ?? process.cwd(),
          baseBranch: options.base,
          message: optionText(options.message),
          notes: optionText(options.notes),
          notesFile: options.notesFile,
        });
      },
    )
    .parseAsync();
}
