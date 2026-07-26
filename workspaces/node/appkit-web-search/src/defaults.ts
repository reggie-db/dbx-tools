/**
 * Interceptor settings for the add-on's three outbound calls: the native
 * web-search POST to Model Serving, the `web_fetch` page read, and the
 * DuckDuckGo scrape fallback. They live here, in the sibling `defaults.ts`
 * AppKit plugins keep, so a TTL or retry budget is tuned in one place instead
 * of at a call site.
 *
 * All three are idempotent READS: none of them create or mutate anything, so
 * both caching and retrying are safe. Each constant below records why its
 * numbers were chosen.
 *
 * @module
 */

/**
 * The `PluginExecuteConfig` slice this package sets. Mirrored structurally
 * because AppKit's `PluginExecuteConfig` lives behind a subpath its `exports`
 * map does not publish, so the nominal type cannot be imported.
 */
export type WebSearchExecuteConfig = {
  cache?: { enabled?: boolean; ttl?: number; cacheKey?: (string | number | object)[] };
  retry?: { enabled?: boolean; attempts?: number; initialDelay?: number; maxDelay?: number };
  timeout?: number;
};

/**
 * The `PluginExecutionSettings` shape accepted by AppKit's `Plugin.execute()`.
 * Mirrored structurally for the same reason as {@link WebSearchExecuteConfig}.
 */
export type WebSearchExecutionSettings = {
  default: WebSearchExecuteConfig;
  user?: WebSearchExecuteConfig;
};

/**
 * Cache lifetime for a native web-search answer. Long enough that a model
 * re-asking the same question inside one conversation does not pay for a
 * second serving call, short enough that "current information" stays current.
 */
export const SEARCH_CACHE_TTL_SECONDS = 300;

/**
 * Cache lifetime for a fetched page. Pages move more slowly than search
 * results, and an agent commonly re-reads the same source across turns.
 */
export const FETCH_CACHE_TTL_SECONDS = 900;

/**
 * Attempts for a serving call. Model Serving sheds load with 429 / 503 under
 * contention; three attempts with AppKit's exponential backoff and full jitter
 * clears that without turning a genuine outage into a long stall.
 */
export const SERVING_RETRY_ATTEMPTS = 3;

/**
 * Attempts for an open-web request. Kept lower than the serving budget: a
 * remote site that refuses once usually refuses again, and the caller is
 * waiting on an interactive tool call.
 */
export const WEB_RETRY_ATTEMPTS = 2;

/**
 * Settings for the native web-search POST to Model Serving.
 *
 * Cache enabled: the POST is a pure read of the model's answer for one query,
 * and repeat asks of the same question are common in a multi-turn agent.
 * Retry enabled: the POST creates no conversation or state, so replaying it
 * after a transient 429 / 5xx is safe.
 */
export const webSearchExecuteDefaults: WebSearchExecutionSettings = {
  default: {
    cache: { enabled: true, ttl: SEARCH_CACHE_TTL_SECONDS },
    retry: { enabled: true, attempts: SERVING_RETRY_ATTEMPTS },
  },
};

/**
 * Settings for a `web_fetch` page read.
 *
 * Cache enabled: fetching a URL is a read, and an agent that searches then
 * reads its own citations hits the same page repeatedly.
 * Retry enabled: a GET is idempotent, so a dropped connection is worth one
 * more attempt.
 */
export const webFetchExecuteDefaults: WebSearchExecutionSettings = {
  default: {
    cache: { enabled: true, ttl: FETCH_CACHE_TTL_SECONDS },
    retry: { enabled: true, attempts: WEB_RETRY_ATTEMPTS },
  },
};

/**
 * Settings for the DuckDuckGo scrape fallback. Same read semantics as the
 * native search, and the shorter cache lifetime applies for the same reason,
 * but the retry budget follows the open-web one: DuckDuckGo answers a repeat
 * request with a bot challenge rather than results.
 */
export const scrapeSearchExecuteDefaults: WebSearchExecutionSettings = {
  default: {
    cache: { enabled: true, ttl: SEARCH_CACHE_TTL_SECONDS },
    retry: { enabled: true, attempts: WEB_RETRY_ATTEMPTS },
  },
};

/**
 * Bind one of the named defaults to a single call: the configured network
 * timeout and the cache key for this request.
 *
 * AppKit only installs the cache interceptor when a non-empty `cacheKey` is
 * present, so every cached call has to name its own key parts. The per-user
 * half of the key is added by `execute()` from the active execution context,
 * which is what keeps an OBO result from leaking across identities.
 */
export function toCallSettings(
  base: WebSearchExecutionSettings,
  timeoutMs: number,
  cacheKey: readonly (string | number)[],
): WebSearchExecutionSettings {
  return {
    default: {
      ...base.default,
      cache: { ...base.default.cache, cacheKey: [...cacheKey] },
      timeout: timeoutMs,
    },
    ...(base.user ? { user: base.user } : {}),
  };
}
