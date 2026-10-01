/**
 * Teams runtime construction and execution helpers.
 *
 * Each plugin instance owns one runtime. Standalone operations and tool
 * factories create or receive their own runtime, so separate apps cannot
 * overwrite each other's card config, webhook, or executor.
 *
 * @module
 */

import { ExecutionError, type ExecutionResult } from "@databricks/appkit";
import { execution as appkitExecution } from "@dbx-tools/appkit";
import { execution, log } from "@dbx-tools/shared-core";
import { card } from "@dbx-tools/shared-teams";
import { buildCardResult } from "./builder.ts";
import { resolveTeamsConfig, type ResolvedTeamsConfig, type TeamsPluginConfig } from "./config.ts";
import {
  TEAMS_BUILD_SETTINGS,
  TEAMS_POST_SETTINGS,
  type TeamsExecutionSettings,
} from "./defaults.ts";

const logger = log.logger("teams/runtime");

/**
 * Runs one operation through AppKit's interceptor chain. Matches
 * `Plugin.execute()`, which never throws: a failure comes back as
 * `{ ok: false }`.
 */
export type TeamsExecutor = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  settings: TeamsExecutionSettings,
) => Promise<ExecutionResult<T>>;

/** The resolved config plus the executor operations run through. */
export interface TeamsRuntime {
  config: ResolvedTeamsConfig;
  execute: TeamsExecutor;
}

/**
 * Executor used by standalone runtimes: run the call directly, mapping a throw
 * onto the same {@link ExecutionResult} shape so call sites branch on `ok`
 * either way.
 */
const directExecute = execution.directExecutor<TeamsExecutionSettings>();

/** Build an isolated runtime for one plugin instance or standalone tool set. */
export function createTeamsRuntime(
  overrides?: TeamsPluginConfig,
  execute: TeamsExecutor = directExecute,
): TeamsRuntime {
  return { config: resolveTeamsConfig(overrides), execute };
}

/** Install an executor on an explicit runtime. */
export function setTeamsExecutor(runtime: TeamsRuntime, execute: TeamsExecutor): void {
  runtime.execute = execute;
}

/**
 * Run one operation through the runtime executor and unwrap it.
 *
 * `execute()` never throws, so a failed call arrives as `{ ok: false }` with a
 * status the interceptors already sanitized; it is logged here and re-raised as
 * a stable {@link ExecutionError} so an upstream message never becomes the
 * caller's error text.
 */
async function run<T>(
  runtime: TeamsRuntime,
  operation: string,
  settings: TeamsExecutionSettings,
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return appkitExecution.runPluginExecution({
    plugin: "teams",
    logger,
    operation,
    settings,
    execute: runtime.execute,
    fn,
    signal,
  });
}

/**
 * Compile a card through an explicit runtime.
 */
export async function buildCardWithRuntime(
  runtime: TeamsRuntime,
  spec: card.CardSpec,
  signal?: AbortSignal,
): Promise<card.CardResult> {
  const { config } = runtime;
  return run(
    runtime,
    "build",
    TEAMS_BUILD_SETTINGS,
    async () => {
      const result = buildCardResult(spec);
      result.card.version = config.cardVersion;
      return result;
    },
    signal,
  );
}

/**
 * Compile a card with isolated environment-derived config and direct
 * execution. Use {@link buildCardWithRuntime} to reuse an explicit runtime.
 */
export function buildCard(spec: card.CardSpec, signal?: AbortSignal): Promise<card.CardResult> {
  return buildCardWithRuntime(createTeamsRuntime(), spec, signal);
}

/**
 * POST a compiled Adaptive Card to the configured Teams incoming webhook,
 * wrapped in the `MessageCard` attachment envelope Teams expects. Throws when
 * no webhook is configured, so a caller that reaches here without one gets a
 * clear error rather than a silent no-op.
 */
export async function postCardWithRuntime(
  runtime: TeamsRuntime,
  cardDocument: card.AdaptiveCard,
  signal?: AbortSignal,
): Promise<void> {
  const { config } = runtime;
  const webhookUrl = config.webhookUrl;
  if (!webhookUrl) {
    throw new ExecutionError("teams: no webhook configured", {
      context: { operation: "post" },
    });
  }
  await run(
    runtime,
    "post",
    TEAMS_POST_SETTINGS,
    async (executeSignal) => {
      const body = {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: cardDocument,
          },
        ],
      };
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(executeSignal ? { signal: executeSignal } : {}),
      });
      if (!response.ok) {
        throw new ExecutionError(`teams: webhook responded ${response.status}`, {
          context: { operation: "post", status: response.status },
        });
      }
    },
    signal,
  );
}

/**
 * Post a card with isolated environment-derived config and direct execution.
 * Use {@link postCardWithRuntime} to reuse an explicit runtime.
 */
export function postCard(cardDocument: card.AdaptiveCard, signal?: AbortSignal): Promise<void> {
  return postCardWithRuntime(createTeamsRuntime(), cardDocument, signal);
}
