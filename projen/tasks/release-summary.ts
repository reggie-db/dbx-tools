#!/usr/bin/env -S bun
/**
 * Optional AI-generated release summary with CLI fallback.
 *
 * @module
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { releaseSummaryFile } from "../src/release-dispatch.ts";

const logger = log.logger("projen:release-summary");

export interface ReleaseSummaryProvider {
  readonly name: "cursor" | "codex" | "claude";
  readonly command: string;
  readonly probeArgs: readonly string[];
  args(root: string, prompt: string): string[];
}

export const RELEASE_SUMMARY_PROVIDERS: readonly ReleaseSummaryProvider[] = [
  {
    name: "cursor",
    command: "cursor",
    probeArgs: ["agent", "--version"],
    args: (root, prompt) => [
      "agent",
      "--print",
      "--mode",
      "ask",
      "--trust",
      "--workspace",
      root,
      prompt,
    ],
  },
  {
    name: "codex",
    command: "codex",
    probeArgs: ["--version"],
    args: (root, prompt) => [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-C",
      root,
      prompt,
    ],
  },
  {
    name: "claude",
    command: "claude",
    probeArgs: ["--version"],
    args: (_root, prompt) => ["--print", "--no-session-persistence", "--tools", "", prompt],
  },
];

export type ReleaseSummaryRunner = (
  provider: ReleaseSummaryProvider,
  root: string,
  prompt: string,
) => string | undefined;

function capture(root: string, command: string, args: string[]): string {
  const result = exec.spawnSync(command, args, {
    cwd: root,
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
  });
  return result.exitCode === 0 ? (result.stdout?.trim() ?? "") : "";
}

function runProvider(
  provider: ReleaseSummaryProvider,
  root: string,
  prompt: string,
): string | undefined {
  if (!capture(root, provider.command, [...provider.probeArgs])) return undefined;
  const summary = capture(root, provider.command, provider.args(root, prompt));
  return summary || undefined;
}

/** Return the first non-empty provider response in Cursor, Codex, Claude order. */
export function selectReleaseSummary(
  root: string,
  prompt: string,
  runner: ReleaseSummaryRunner = runProvider,
): { provider: ReleaseSummaryProvider["name"]; summary: string } | undefined {
  for (const provider of RELEASE_SUMMARY_PROVIDERS) {
    const summary = runner(provider, root, prompt)?.trim();
    if (summary) return { provider: provider.name, summary };
  }
  return undefined;
}

function summaryPrompt(
  version: string,
  fromRef: string | undefined,
  commits: string,
  changedFiles: string,
  diffStat: string,
): string {
  return [
    `Write a concise user-facing Markdown release summary for dbx-tools ${version}.`,
    "Use only the supplied Git context. Do not run commands, edit files, speculate,",
    "mention commit hashes, use emojis, or use em/en dashes.",
    "Return no title and no fenced block. Start with one short paragraph, then",
    "group concrete changes under brief Markdown headings with bullets.",
    "",
    `Comparison base: ${fromRef ?? "repository root"}`,
    "",
    "Commits:",
    commits || "(none)",
    "",
    "Changed files:",
    changedFiles || "(none)",
    "",
    "Diff stat:",
    diffStat || "(none)",
  ].join("\n");
}

/** Generate one immutable versioned summary, or remove a stale retry artifact. */
export function generateReleaseSummary(options: {
  readonly root: string;
  readonly version: string;
  readonly fromRef?: string;
  readonly toRef?: string;
  readonly runner?: ReleaseSummaryRunner;
}): string | undefined {
  const relativeOutput = releaseSummaryFile(options.version);
  const output = join(options.root, relativeOutput);
  if (existsSync(output)) rmSync(output);
  const target =
    options.toRef && capture(options.root, "git", ["rev-parse", "--verify", options.toRef])
      ? options.toRef
      : "HEAD";
  const range =
    options.fromRef && capture(options.root, "git", ["rev-parse", "--verify", options.fromRef])
      ? `${options.fromRef}..${target}`
      : target;
  const commits = capture(options.root, "git", ["log", "--no-merges", "--format=%s%n%b", range]);
  const changedFiles = capture(options.root, "git", [
    "diff",
    "--name-status",
    range,
    "--",
    ".",
    `:(exclude)${relativeOutput}`,
  ]);
  const diffStat = capture(options.root, "git", [
    "diff",
    "--stat",
    range,
    "--",
    ".",
    `:(exclude)${relativeOutput}`,
  ]);
  const result = selectReleaseSummary(
    options.root,
    summaryPrompt(options.version, options.fromRef, commits, changedFiles, diffStat),
    options.runner,
  );
  if (!result) {
    logger.info("no supported AI CLI available; skipping release summary");
    return undefined;
  }
  const content = `# Release ${options.version}\n\n${result.summary.trim()}\n`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
  logger.info("generated", { provider: result.provider, path: output });
  return content;
}
