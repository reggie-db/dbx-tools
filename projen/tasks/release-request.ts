#!/usr/bin/env -S bun
/** Commit and push a source branch for the generated release-request workflow. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { project } from "@dbx-tools/core";
import { log, string } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { selectReleaseSummary } from "./release-summary.ts";
import { captureTaskCommand, runTaskCommand } from "../src/_task-command.ts";

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
    runTaskCommand(root, process.execPath, ["x", "projen"]);
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
    logger.info("release request already exists at branch head; skipping", { branch });
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
  if (options.push !== false) run(root, ["push", "--set-upstream", "origin", branch]);
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

function capture(root: string, args: string[]): string {
  return captureTaskCommand(root, "git", args, { check: true, stderr: "inherit" });
}

function run(root: string, args: string[]): void {
  runTaskCommand(root, "git", args);
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
