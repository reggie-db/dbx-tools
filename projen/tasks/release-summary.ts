#!/usr/bin/env -S bun
/**
 * Optional AI-generated release summary with CLI fallback.
 *
 * @module
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, projectUtils } from "@dbx-tools/core";
import { json, log, object, stringUtils } from "@dbx-tools/shared-core";
import { captureTaskCommand } from "../src/_task-command.ts";
import {
  RELEASE_SUMMARY_PROVIDER_NAMES,
  releaseSummaryFile,
  type ReleaseSummaryProviderName,
} from "../src/release-dispatch.ts";

const logger = log.logger("projen:release-summary");
const PROVIDER_TIMEOUT_MS = 60_000;
const PROVIDER_KILL_GRACE_MS = 5_000;

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
  return captureTaskCommand(root, command, args);
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return stringUtils.trimToNull(value) ?? undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) => (object.isRecord(item) && typeof item.text === "string" ? [item.text] : []))
    .join("");
  return stringUtils.trimToNull(text) ?? undefined;
}

function eventText(event: Record<string, unknown>): string | undefined {
  if (typeof event.result === "string") return stringUtils.trimToNull(event.result) ?? undefined;
  const item = object.isRecord(event.item) ? event.item : undefined;
  if (item?.type === "agent_message" && typeof item.text === "string") {
    return stringUtils.trimToNull(item.text) ?? undefined;
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
    if (typeof value === "string") return stringUtils.trimToNull(value) ?? undefined;
  }
  return undefined;
}

function eventToolName(event: Record<string, unknown>): string | undefined {
  const item = object.isRecord(event.item) ? event.item : undefined;
  for (const value of [event.tool_name, event.toolName, event.name, item?.tool_name, item?.name]) {
    if (typeof value === "string") return stringUtils.trimToNull(value) ?? undefined;
  }
  const toolCall = object.isRecord(event.tool_call)
    ? event.tool_call
    : object.isRecord(event.toolCall)
      ? event.toolCall
      : undefined;
  const wrapper = toolCall
    ? Object.keys(toolCall).find(
        (key) => key.endsWith("ToolCall") && object.isRecord(toolCall[key]),
      )
    : undefined;
  return wrapper ? wrapper.slice(0, -"ToolCall".length) : undefined;
}

/** Normalize one provider event into the fields retained in release logs. */
export function releaseSummaryProviderEvent(event: Record<string, unknown>): {
  type: string;
  text?: string;
  detail?: string;
  tool?: string;
} {
  const text = eventText(event);
  const detail = eventDetail(event);
  const tool = eventToolName(event);
  return {
    type: eventType(event),
    ...(text ? { text } : {}),
    ...(detail ? { detail } : {}),
    ...(tool ? { tool } : {}),
  };
}

async function runProvider(
  provider: ReleaseSummaryProvider,
  root: string,
  prompt: string,
): Promise<string | undefined> {
  if (!capture(root, provider.command, [...provider.probeArgs])) return undefined;
  let summary: string | undefined;
  let previousEventKey: string | undefined;
  const textOutput: string[] = [];
  const logEvent = (event: Record<string, unknown>) => {
    const fields = { provider: provider.name, ...event };
    const key = JSON.stringify(fields);
    if (key === previousEventKey) return;
    previousEventKey = key;
    logger.info("provider-event", fields);
  };
  const child = exec.spawn(provider.command, provider.args(root, prompt), {
    cwd: root,
    stdout: [
      "capture",
      (line) => {
        const event = json.parseRecord(line);
        if (!event) {
          const text = stringUtils.trimToNull(line);
          if (text) {
            textOutput.push(text);
            logEvent({ type: "text", text });
          }
          return;
        }
        const fields = releaseSummaryProviderEvent(event);
        if (fields.text) summary = fields.text;
        logEvent(fields);
      },
    ],
    stderr: (line) => {
      const message = stringUtils.trimToNull(line);
      if (message) logger.warn("provider-stderr", { provider: provider.name, message });
    },
    stdin: "ignore",
    check: false,
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    logger.warn("provider-timeout", {
      provider: provider.name,
      timeoutMs: PROVIDER_TIMEOUT_MS,
    });
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), PROVIDER_KILL_GRACE_MS);
    escalation.unref();
  }, PROVIDER_TIMEOUT_MS);
  timeout.unref();
  const result = await child.finally(() => {
    clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
  });
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
  projectName: string,
  version: string,
  fromRef: string | undefined,
  commits: string,
  changedFiles: string,
  diffStat: string,
): string {
  return [
    `Write a concise user-facing Markdown release summary for ${projectName} ${version}.`,
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

/** Deterministic fallback when every configured AI provider is unavailable. */
function gitSummary(
  projectName: string,
  version: string,
  commits: string,
  changedFiles: string,
): string {
  const subjects = commits
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, 20);
  const files = changedFiles
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter((value): value is string => Boolean(value));
  const areas = files
    .map((file) => {
      if (file.startsWith("packages/")) return file.split("/").slice(0, 4).join("/");
      return file.split("/")[0] ?? file;
    })
    .filter((area, index, all) => all.indexOf(area) === index)
    .slice(0, 12);
  const bullets = subjects.length ? subjects : areas.map((area) => `Updated ${area}`);
  return [
    `${projectName} ${version} contains the reviewed changes listed below.`,
    "",
    "## Changes",
    ...(bullets.length ? bullets.map((item) => `- ${item}`) : ["- Release metadata updated."]),
  ].join("\n");
}

/** Generate one immutable versioned summary with an AI or Git fallback. */
export async function generateReleaseSummary(options: {
  readonly root: string;
  readonly version: string;
  readonly component?: string;
  readonly paths?: readonly string[];
  readonly customSummary?: string;
  readonly outputFile?: string;
  readonly fromRef?: string;
  readonly toRef?: string;
  readonly providers?: readonly ReleaseSummaryProviderName[];
  readonly runner?: ReleaseSummaryRunner;
}): Promise<string | undefined> {
  const projectName = projectUtils.name(options.root);
  const relativeOutput =
    options.outputFile ?? releaseSummaryFile(options.version, options.component);
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
  const scopedPaths = options.paths?.length ? [...options.paths] : ["."];
  const commits = capture(options.root, "git", [
    "log",
    "--no-merges",
    "--format=%s%n%b",
    range,
    "--",
    ...scopedPaths,
  ]);
  const changedFiles = capture(options.root, "git", [
    "diff",
    "--name-status",
    range,
    "--",
    ...scopedPaths,
    `:(exclude)${relativeOutput}`,
  ]);
  const diffStat = capture(options.root, "git", [
    "diff",
    "--stat",
    range,
    "--",
    ...scopedPaths,
    `:(exclude)${relativeOutput}`,
  ]);
  const customSummary = stringUtils.trimToNull(options.customSummary);
  const result = customSummary
    ? undefined
    : await selectReleaseSummary(
        options.root,
        summaryPrompt(
          projectName,
          options.version,
          options.fromRef,
          commits,
          changedFiles,
          diffStat,
        ),
        options.runner,
        options.providers,
      );
  const summary =
    customSummary ??
    result?.summary ??
    gitSummary(projectName, options.version, commits, changedFiles);
  const provider = customSummary ? "custom" : (result?.provider ?? "git");
  if (!customSummary && !result) {
    logger.info("AI providers unavailable; using Git release summary");
  }
  const content = `# Release ${options.component ? `${options.component} ` : ""}${options.version}\n\n${summary.trim()}\n`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
  logger.info("generated", { provider, path: output });
  return content;
}
