/**
 * Write user-facing release notes under `docs/releases/` during `bun run release`.
 *
 * Prefers Genie Code (`dbx genie exec`). When that fails or writes an empty
 * file, falls back to a short git-log summary so the release still commits notes.
 *
 * @module
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "@dbx-tools/shared-core";

import { captureTaskCommand, tryTaskCommand } from "../src/_task-command.ts";

const logger = log.logger("projen:release-notes");

const GENIE_PROMPT =
  "Compare HEAD and the working tree against the latest v* tag. Produce concise user-facing release notes. Ignore generated-file churn and test-only changes. Include breaking changes, fixes, and validation results. The configured release validation phase has already completed, so do not run tests or other validation commands and do not invent validation counts. Do not modify files.";

/** Inputs for one notes write. */
export interface WriteReleaseNotesOptions {
  /** Extra agent instructions appended after the standard release-note requirements. */
  readonly instructions?: string;
  readonly prefix: string;
  readonly root: string;
  readonly version: string;
  /** Override Genie invocation; return false to force the git-log fallback. */
  readonly runGenie?: (args: readonly string[]) => boolean;
}

/** Compose the stable release-note prompt with optional caller guidance. */
export function releaseNotesPrompt(instructions?: string): string {
  const additional = instructions?.trim();
  return additional ? `${GENIE_PROMPT}\n\nAdditional instructions:\n${additional}` : GENIE_PROMPT;
}

/** Path of the notes file for one workspace version. */
export function releaseNotesPath(root: string, version: string): string {
  return join(root, "docs", "releases", `v${version}.md`);
}

/** Short markdown notes from commit subjects since the previous matching tag. */
export function fallbackReleaseNotes(
  version: string,
  commits: readonly string[],
  previousTag?: string,
): string {
  const range = previousTag ? `since ${previousTag}` : "in this release";
  const items =
    commits.length > 0
      ? commits.map((subject) => `- ${subject}`).join("\n")
      : "- Version bump and synchronized package metadata.";
  return `# Release ${version}\n\ndbx-tools ${version} ${range}.\n\n${items}\n`;
}

/** Run Genie into `docs/releases/vX.Y.Z.md`, or write {@link fallbackReleaseNotes}. */
export function writeReleaseNotes(options: WriteReleaseNotesOptions): string {
  const { prefix, root, version } = options;
  const destination = releaseNotesPath(root, version);
  mkdirSync(dirname(destination), { recursive: true });
  const relative = join("docs", "releases", `v${version}.md`);
  const genieArgs = [
    "exec",
    "-C",
    root,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "-o",
    relative,
    releaseNotesPrompt(options.instructions),
  ] as const;
  const ran =
    options.runGenie?.([...genieArgs]) ??
    tryTaskCommand(root, "bun", ["run", "dbx", "genie", ...genieArgs]);
  if (ran && readNotes(destination)) {
    logger.info("wrote Genie release notes", { path: relative });
    return destination;
  }
  const previousTag = captureTaskCommand(root, "git", [
    "describe",
    "--tags",
    "--abbrev=0",
    `--match=${prefix}*`,
  ]);
  const logArgs = previousTag
    ? ["log", "--no-merges", "--pretty=format:%s", `${previousTag}..HEAD`]
    : ["log", "--no-merges", "--pretty=format:%s", "-15"];
  const commits = captureTaskCommand(root, "git", logArgs)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  writeFileSync(destination, fallbackReleaseNotes(version, commits, previousTag || undefined));
  logger.warn("Genie release notes unavailable; wrote git-log summary", { path: relative });
  return destination;
}

function readNotes(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
