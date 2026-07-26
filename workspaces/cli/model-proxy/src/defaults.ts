// Default values for the local Databricks model proxy.

import { object } from "@dbx-tools/shared-core";

/**
 * Loopback address the proxy binds to by default. Keeps the OpenAI-compatible
 * endpoint private to the machine unless the operator explicitly opts into a
 * wider bind (e.g. `0.0.0.0`).
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Default TCP port for the local proxy. */
export const DEFAULT_PORT = 4000;

/**
 * Resolved policy for absorbing upstream `429 Too Many Requests` responses.
 *
 * Databricks Foundation Model endpoints are pay-per-token with an account-level
 * throughput ceiling that is not exposed as a readable number, so the proxy
 * cannot pace against it proactively - it can only react. When `enabled`, a 429
 * is retried in-proxy with exponential backoff (honoring any `Retry-After`)
 * instead of being relayed to the client, so an agentic caller like Codex sees
 * a slow success rather than "exceeded retry limit".
 */
export interface RetryConfig {
  /** Retry 429s in-proxy rather than relaying them. */
  enabled: boolean;
  /** Maximum retry attempts after the initial try (so N+1 total requests). */
  maxRetries: number;
  /** First backoff, doubled each attempt (before jitter and the `Retry-After` override). */
  baseDelayMs: number;
  /** Ceiling for any single backoff, including a server-sent `Retry-After`. */
  maxDelayMs: number;
}

/** Built-in retry policy: on, with a bounded exponential backoff. */
export const DEFAULT_RETRY: RetryConfig = {
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/** Positive integer from an env var, or `undefined` when unset/unparseable. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * Resolve the 429-retry policy from, in decreasing precedence: an explicit
 * override (the CLI flag), environment variables, then {@link DEFAULT_RETRY}.
 *
 * `enabled` layers as: a CLI `--no-retry-429` (`override.enabled === false`)
 * always wins; otherwise `PROXY_RETRY_ON_429` (loose boolean via
 * {@link object.toBoolean}) may switch it off; otherwise it stays on. There is
 * deliberately no enable flag - the default is on, so the only meaningful
 * action is disabling.
 *
 * Tunables read `PROXY_RETRY_MAX`, `PROXY_RETRY_BASE_MS`, `PROXY_RETRY_MAX_MS`.
 */
export function resolveRetryConfig(override: Partial<RetryConfig> = {}): RetryConfig {
  const envEnabled = object.toBoolean(process.env.PROXY_RETRY_ON_429);
  const enabled = override.enabled ?? envEnabled ?? DEFAULT_RETRY.enabled;
  return {
    enabled,
    maxRetries: override.maxRetries ?? envInt("PROXY_RETRY_MAX") ?? DEFAULT_RETRY.maxRetries,
    baseDelayMs: override.baseDelayMs ?? envInt("PROXY_RETRY_BASE_MS") ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: override.maxDelayMs ?? envInt("PROXY_RETRY_MAX_MS") ?? DEFAULT_RETRY.maxDelayMs,
  };
}
