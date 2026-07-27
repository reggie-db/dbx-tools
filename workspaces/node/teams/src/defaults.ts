/**
 * Interceptor defaults for the Teams plugin.
 *
 * Building a card is a pure transform, but it still runs through
 * `Plugin.execute()` so it shares the app's telemetry / timeout posture; the
 * one operation that does I/O is posting a card to a Teams incoming webhook.
 * The settings are kept here rather than at the call sites so the caching /
 * retry / timeout posture of each is reviewable in one place.
 *
 * @module
 */

/**
 * The `PluginExecuteConfig` slice this package sets. Mirrored structurally
 * because AppKit's `PluginExecuteConfig` lives behind a subpath its `exports`
 * map does not publish, so the nominal type cannot be imported. Written as a
 * type alias rather than an interface so it stays assignable to the nominal
 * type's index signature.
 */
export type TeamsExecuteConfig = {
  cache?: { enabled?: boolean; ttl?: number; cacheKey?: (string | number | object)[] };
  retry?: { enabled?: boolean; attempts?: number; initialDelay?: number; maxDelay?: number };
  timeout?: number;
};

/**
 * The `PluginExecutionSettings` shape accepted by AppKit's `Plugin.execute()`.
 * Mirrored structurally for the same reason as {@link TeamsExecuteConfig}.
 */
export type TeamsExecutionSettings = {
  default: TeamsExecuteConfig;
  user?: TeamsExecuteConfig;
};

/** Ceiling on how long a single card build may take. */
export const BUILD_TIMEOUT_MS = 5_000;

/** Ceiling on how long a single webhook POST may take. */
export const POST_TIMEOUT_MS = 15_000;

/** Attempts allowed for a webhook POST, including the first. */
export const POST_ATTEMPTS = 3;

/** Execution settings for building a card (a pure, in-process transform). */
export const TEAMS_BUILD_SETTINGS: TeamsExecutionSettings = {
  default: {
    // Cache disabled: the build is cheap and deterministic, so a cache would
    // add a cross-identity key surface for no measurable saving.
    cache: { enabled: false },
    // Retry disabled: the transform performs no I/O, so a failure is
    // deterministic and a second attempt would fail identically.
    retry: { enabled: false },
    timeout: BUILD_TIMEOUT_MS,
  },
};

/**
 * Ceiling on one conversation turn. Generous relative to the other two: a turn
 * spans a full agent call (model latency plus any tool the agent runs), so it is
 * bounded by the same order of magnitude as a chat request rather than a
 * transform.
 */
export const TURN_TIMEOUT_MS = 120_000;

/** Execution settings for one Teams conversation turn (an agent call). */
export const TEAMS_TURN_SETTINGS: TeamsExecutionSettings = {
  default: {
    // Cache disabled: a turn is conversational and stateful - the same text in
    // a different conversation must not replay an earlier card.
    cache: { enabled: false },
    // Retry disabled: a turn may have run tools with side effects before it
    // failed, and re-running the model would double them.
    retry: { enabled: false },
    timeout: TURN_TIMEOUT_MS,
  },
};

/** Execution settings for posting a card to a Teams incoming webhook. */
export const TEAMS_POST_SETTINGS: TeamsExecutionSettings = {
  default: {
    // Cache disabled: a post is a side effect, not a value. Replaying a cached
    // result would report a delivery that never happened.
    cache: { enabled: false },
    // Retry enabled: a webhook POST is idempotent enough that a transient 5xx
    // or timeout at the Teams edge is worth one or two more attempts.
    retry: { enabled: true, attempts: POST_ATTEMPTS },
    timeout: POST_TIMEOUT_MS,
  },
};
