/**
 * Write user-facing release notes under `docs/releases/` during `bun run release`.
 *
 * Prefers Genie Code (`dbx genie exec`). When that fails or writes an empty
 * file, falls back to a short git-log summary so the release still commits notes.
 *
 * @module
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "@dbx-tools/shared-core";

import { captureTaskCommand, tryTaskCommand } from "../src/_task-command.ts";

const logger = log.logger("projen:release-notes");

const GENIE_PROMPT =
  "Produce concise user-facing release notes. Ignore generated-file churn and test-only changes. Include breaking changes, fixes, and validation results. The configured release validation phase has already completed, so do not run tests or other validation commands and do not invent validation counts. Do not modify files.";

/** Inputs that define the release-note comparison and optional caller guidance. */
export interface ReleaseNotesPromptOptions {
  /** Release tag whose GitHub Actions release workflow most recently succeeded. */
  readonly successfulTag?: string;
  /** Extra agent instructions appended after the standard release-note requirements. */
  readonly instructions?: string;
  /** Release tag prefix used when no successful GitHub baseline exists. */
  readonly prefix: string;
}

/** Inputs for one notes write. */
export interface WriteReleaseNotesOptions {
  /** Complete release-note content supplied by the caller instead of Genie. */
  readonly content?: string;
  /** File containing complete release notes supplied by the caller instead of Genie. */
  readonly file?: string;
  /** Extra agent instructions appended after the standard release-note requirements. */
  readonly instructions?: string;
  readonly prefix: string;
  readonly root: string;
  /** Release tag whose GitHub Actions release workflow most recently succeeded. */
  readonly successfulTag?: string;
  readonly version: string;
  /** Override Genie invocation; return false to force the git-log fallback. */
  readonly runGenie?: (args: readonly string[]) => boolean;
}

/** Compose the stable release-note prompt with the deployed baseline and caller guidance. */
export function releaseNotesPrompt(options: ReleaseNotesPromptOptions): string {
  const baseline = options.successfulTag
    ? `The latest GitHub release workflow that completed successfully is ${options.successfulTag}. Compare ${options.successfulTag}..HEAD plus the working tree. Treat any newer ${options.prefix}* tags and their release-note files as failed release attempts: combine their user-facing changes into this release, verify them against the cumulative code delta, and do not shorten the comparison to those failed tags. Do not reduce the notes to retry-only deployment or workflow fixes such as \"changed workflow X\" when unreleased product changes are part of the same cumulative delta.`
    : `No successful GitHub release workflow baseline was found. Do not assume the latest ${options.prefix}* tag deployed successfully. Inspect the available release-note files, tags, git history, HEAD, and the working tree, then produce cumulative notes for the user-facing changes not known to have shipped successfully. Do not reduce the notes to retry-only deployment or workflow fixes when unreleased product changes are present.`;
  const prompt = `${baseline}\n\n${GENIE_PROMPT}`;
  const additional = options.instructions?.trim();
  return additional ? `${prompt}\n\nAdditional instructions:\n${additional}` : prompt;
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
  const suppliedContent = options.content?.trim();
  const suppliedFile = options.file?.trim();
  if (suppliedContent && suppliedFile) {
    throw new Error("release notes content and file are mutually exclusive");
  }
  if (options.content !== undefined) {
    if (!suppliedContent) throw new Error("release notes content must not be empty");
    writeFileSync(destination, `${suppliedContent}\n`);
    logger.info("wrote supplied release notes", { path: relative });
    return destination;
  }
  if (options.file !== undefined) {
    if (!suppliedFile) throw new Error("release notes file must not be empty");
    const content = readNotes(resolve(root, suppliedFile));
    if (!content) throw new Error(`release notes file is empty or unreadable: ${suppliedFile}`);
    writeFileSync(destination, `${content}\n`);
    logger.info("copied supplied release notes", { path: relative, source: suppliedFile });
    return destination;
  }
  const genieArgs = [
    "exec",
    "-C",
    root,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "-o",
    relative,
    releaseNotesPrompt({
      instructions: options.instructions,
      prefix,
      successfulTag: options.successfulTag,
    }),
  ] as const;
  const ran =
    options.runGenie?.([...genieArgs]) ??
    tryTaskCommand(root, "bun", ["run", "dbx", "genie", ...genieArgs]);
  if (ran && readNotes(destination)) {
    logger.info("wrote Genie release notes", { path: relative });
    return destination;
  }
  const logArgs = options.successfulTag
    ? ["log", "--no-merges", "--pretty=format:%s", `${options.successfulTag}..HEAD`]
    : ["log", "--no-merges", "--pretty=format:%s", "-15"];
  const commits = captureTaskCommand(root, "git", logArgs)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  writeFileSync(destination, fallbackReleaseNotes(version, commits, options.successfulTag));
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
