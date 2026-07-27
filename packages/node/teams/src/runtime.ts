/**
 * The Teams runtime: a lazily-resolved, process-wide config shared by the
 * plugin and the `create_teams_card` tool, so both read one resolved card
 * version / webhook set. The first caller (normally the plugin at setup)
 * primes it from the plugin's config; later callers (the tool's `execute`)
 * reuse it.
 *
 * The runtime also carries the {@link TeamsExecutor} every operation runs
 * through. The plugin installs its own `execute()` there at setup, which is how
 * the tool - a plain function with no plugin instance in scope - still gets
 * AppKit's cache / retry / timeout / telemetry chain. Without a registered
 * plugin (a direct call from a script or a test) the operations still run, just
 * without interceptors.
 *
 * Like the web-search runtime and unlike the email one, there is no connection
 * pool to hold - card building is in-process and a webhook post is a stateless
 * HTTP call - so the runtime holds only the resolved config and that executor.
 *
 * @module
 */

import { AppKitError, ExecutionError, type ExecutionResult } from "@databricks/appkit";
import { async, error, log } from "@dbx-tools/shared-core";
import { card } from "@dbx-tools/shared-teams";
import { buildCardResult } from "./builder";
import { resolveTeamsConfig, type ResolvedTeamsConfig, type TeamsPluginConfig } from "./config";
import { TEAMS_BUILD_SETTINGS, TEAMS_POST_SETTINGS, type TeamsExecutionSettings } from "./defaults";

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

/** The shared resolved config plus the executor operations run through. */
export interface TeamsRuntime {
  config: ResolvedTeamsConfig;
  execute: TeamsExecutor;
}

/**
 * Executor used until (or unless) the plugin installs its own: run the call
 * directly, mapping a throw onto the same {@link ExecutionResult} shape so
 * call sites branch on `ok` either way.
 */
const directExecute: TeamsExecutor = async (fn) => {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof AppKitError ? err.statusCode : 500,
      message: error.errorMessage(err),
    };
  }
};

let runtime: TeamsRuntime | undefined;

/**
 * Return the shared runtime, building it on first use from the supplied config
 * layered over environment defaults. Overrides are only read when the runtime
 * is first created, so prime it from the plugin's config at setup; subsequent
 * calls (the tool's `execute`) pass nothing and get the same instance.
 */
export function getTeamsRuntime(overrides?: TeamsPluginConfig): TeamsRuntime {
  if (!runtime) {
    runtime = { config: resolveTeamsConfig(overrides), execute: directExecute };
  }
  return runtime;
}

/**
 * Install the executor operations run through. The plugin calls this at setup
 * with its own `execute()`; a second call replaces the previous one, so a
 * re-registered plugin does not leave the tool bound to a dead instance.
 */
export function setTeamsExecutor(execute: TeamsExecutor): void {
  getTeamsRuntime().execute = execute;
}

/** Drop the memoized runtime so the next {@link getTeamsRuntime} rebuilds it. */
export function resetTeamsRuntime(): void {
  runtime = undefined;
}

/**
 * Run one operation through the shared executor and unwrap it.
 *
 * `execute()` never throws, so a failed call arrives as `{ ok: false }` with a
 * status the interceptors already sanitized; it is logged here and re-raised as
 * a stable {@link ExecutionError} so an upstream message never becomes the
 * caller's error text.
 */
async function run<T>(
  operation: string,
  settings: TeamsExecutionSettings,
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { execute } = getTeamsRuntime();
  const result = await execute(
    (executeSignal) => fn(async.combineAbortSignals(executeSignal, signal)),
    settings,
  );
  if (result.ok) return result.data;
  if (signal?.aborted) throw ExecutionError.canceled();
  logger.warn("execution-failed", {
    operation,
    status: result.status,
    error: result.message,
  });
  throw new ExecutionError(`teams: ${operation} failed`, {
    context: { operation, status: result.status },
  });
}

/**
 * Compile a card spec into an Adaptive Card document, stamped with the runtime's
 * resolved card version. Runs through the shared executor so a build picks up
 * the app's telemetry / timeout chain.
 */
export async function buildCard(
  spec: card.CardSpec,
  signal?: AbortSignal,
): Promise<card.CardResult> {
  const { config } = getTeamsRuntime();
  return run(
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
 * POST a compiled Adaptive Card to the configured Teams incoming webhook,
 * wrapped in the `MessageCard` attachment envelope Teams expects. Throws when
 * no webhook is configured, so a caller that reaches here without one gets a
 * clear error rather than a silent no-op.
 */
export async function postCard(
  cardDocument: card.AdaptiveCard,
  signal?: AbortSignal,
): Promise<void> {
  const { config } = getTeamsRuntime();
  const webhookUrl = config.webhookUrl;
  if (!webhookUrl) {
    throw new ExecutionError("teams: no webhook configured", {
      context: { operation: "post" },
    });
  }
  await run(
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
