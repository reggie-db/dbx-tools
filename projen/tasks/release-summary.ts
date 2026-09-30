#!/usr/bin/env -S bun
/**
 * Optional AI-generated release summary with CLI fallback.
 *
 * @module
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "@dbx-tools/core";
import { json, log, object, string } from "@dbx-tools/shared-core";
import {
  RELEASE_SUMMARY_PROVIDER_NAMES,
  releaseSummaryFile,
  type ReleaseSummaryProviderName,
} from "../src/release-dispatch.ts";

const logger = log.logger("projen:release-summary");

export interface ReleaseSummaryProvider {
  readonly name: ReleaseSummaryProviderName;
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
      "--output-format",
      "stream-json",
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
      "--json",
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
    args: (_root, prompt) => [
      "--print",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      prompt,
    ],
  },
];

export type ReleaseSummaryRunner = (
  provider: ReleaseSummaryProvider,
  root: string,
  prompt: string,
) => string | undefined | Promise<string | undefined>;

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

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return string.trimToNull(value) ?? undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) => (object.isRecord(item) && typeof item.text === "string" ? [item.text] : []))
    .join("");
  return string.trimToNull(text) ?? undefined;
}

function eventText(event: Record<string, unknown>): string | undefined {
  if (typeof event.result === "string") return string.trimToNull(event.result) ?? undefined;
  const item = object.isRecord(event.item) ? event.item : undefined;
  if (item?.type === "agent_message" && typeof item.text === "string") {
    return string.trimToNull(item.text) ?? undefined;
  }
  const message = object.isRecord(event.message) ? event.message : undefined;
  return contentText(message?.content);
}

function eventType(event: Record<string, unknown>): string {
  const item = object.isRecord(event.item) ? event.item : undefined;
  return [event.type, item?.type].filter((value) => typeof value === "string").join(":") || "event";
}

function eventDetail(event: Record<string, unknown>): string | undefined {
  const item = object.isRecord(event.item) ? event.item : undefined;
  for (const value of [item?.message, event.message, event.error]) {
    if (typeof value === "string") return string.trimToNull(value) ?? undefined;
  }
  return undefined;
}

async function runProvider(
  provider: ReleaseSummaryProvider,
  root: string,
  prompt: string,
): Promise<string | undefined> {
  if (!capture(root, provider.command, [...provider.probeArgs])) return undefined;
  let summary: string | undefined;
  const textOutput: string[] = [];
  const process = exec.spawn(provider.command, provider.args(root, prompt), {
    cwd: root,
    stdout: [
      "capture",
      (line) => {
        const event = json.parseRecord(line);
        if (!event) {
          const text = string.trimToNull(line);
          if (text) {
            textOutput.push(text);
            logger.info("provider-event", { provider: provider.name, type: "text", text });
          }
          return;
        }
        const text = eventText(event);
        const detail = eventDetail(event);
        if (text) summary = text;
        logger.info("provider-event", {
          provider: provider.name,
          type: eventType(event),
          ...(text ? { text } : {}),
          ...(detail ? { detail } : {}),
        });
      },
    ],
    stderr: (line) => {
      const message = string.trimToNull(line);
      if (message) logger.warn("provider-stderr", { provider: provider.name, message });
    },
    stdin: "ignore",
    check: false,
  });
  const result = await process;
  if (result.exitCode !== 0) {
    logger.warn("provider-failed", { provider: provider.name, exitCode: result.exitCode });
    return undefined;
  }
  return summary ?? (textOutput.length ? textOutput.join("\n") : undefined);
}

/** Return the first non-empty provider response in Cursor, Codex, Claude order. */
export async function selectReleaseSummary(
  root: string,
  prompt: string,
  runner: ReleaseSummaryRunner = runProvider,
  providers: readonly ReleaseSummaryProviderName[] = RELEASE_SUMMARY_PROVIDER_NAMES,
): Promise<{ provider: ReleaseSummaryProvider["name"]; summary: string } | undefined> {
  for (const name of providers) {
    const provider = RELEASE_SUMMARY_PROVIDERS.find((candidate) => candidate.name === name);
    if (!provider) continue;
    const summary = (await runner(provider, root, prompt))?.trim();
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
export async function generateReleaseSummary(options: {
  readonly root: string;
  readonly version: string;
  readonly fromRef?: string;
  readonly toRef?: string;
  readonly providers?: readonly ReleaseSummaryProviderName[];
  readonly runner?: ReleaseSummaryRunner;
}): Promise<string | undefined> {
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
  const result = await selectReleaseSummary(
    options.root,
    summaryPrompt(options.version, options.fromRef, commits, changedFiles, diffStat),
    options.runner,
    options.providers,
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
