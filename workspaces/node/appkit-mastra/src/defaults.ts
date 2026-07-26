/**
 * Interceptor defaults for every outbound call the plugin's own routes make
 * through `Plugin.execute()`.
 *
 * One constant per call site so the cache / retry / timeout decision lives
 * beside its reasoning instead of at the call site. The interceptor chain runs
 * telemetry, timeout, retry, cache, so a disabled interceptor is a deliberate
 * choice and is commented as such.
 *
 * The cache interceptor is inert without a `cache.cacheKey`, which is
 * request-specific (a statement id, an agent id). Call sites therefore spread
 * the constant and add the key; the identity namespace comes from the
 * execution context's user id, which `execute()` resolves on its own.
 *
 * Cancellation is not expressed here: `execute()` derives a signal from the
 * `timeout` setting only, so a caller's own signal is combined with it at the
 * call site instead.
 *
 * @module
 */

/**
 * Per-call interceptor settings. Structural stand-in for AppKit's
 * `PluginExecuteConfig`: the barrel exports `StreamExecutionSettings` but not
 * the non-streaming config, so the nominal type is unimportable here. Declared
 * as a type alias (not an interface) so it keeps the implicit index signature
 * AppKit's own config carries.
 */
type ExecuteConfig = {
  cache?: { enabled?: boolean; ttl?: number; cacheKey?: (string | number | object)[] };
  retry?: { enabled?: boolean; attempts?: number; initialDelay?: number; maxDelay?: number };
  timeout?: number;
};

/** Default plus optional user-scoped settings, as `execute()` accepts them. */
type ExecuteSettings = {
  default: ExecuteConfig;
  user?: ExecuteConfig;
};

/** Ceiling on a single Model Serving / Genie / MLflow REST round-trip. */
const REST_TIMEOUT_MS = 30_000;

/** Ceiling on one Statement Execution fetch, which can page a large result. */
const STATEMENT_TIMEOUT_MS = 60_000;

/** TTL for a cached statement result set, in seconds. */
const STATEMENT_CACHE_TTL_SEC = 5 * 60;

/**
 * `GET /models`: the workspace's Model Serving catalogue.
 */
export const modelCatalogueDefaults: ExecuteSettings = {
  default: {
    // Cache disabled here because `listServingEndpoints` already memoizes the
    // catalogue through the same `CacheManager`, keyed by workspace host with
    // `config.modelCacheTtlMs`. That entry is shared across identities; a
    // second interceptor cache would duplicate it once per user.
    cache: { enabled: false },
    // Retry enabled: listing endpoints is an idempotent GET, and the listing
    // is on the chat UI's load path, so a transient 5xx should not blank the
    // model picker.
    retry: { enabled: true, attempts: 3 },
    timeout: REST_TIMEOUT_MS,
  },
};

/**
 * `GET /suggestions`: the curated `sample_questions` on each Genie space.
 */
export const genieSuggestionDefaults: ExecuteSettings = {
  default: {
    // Cache disabled here because `collectSpaceSuggestions` keeps its own
    // space-id-keyed entry; the questions are authored config, identical for
    // every caller, so caching them per identity would only fan out copies.
    cache: { enabled: false },
    // Retry enabled: reading space metadata is idempotent, and the route
    // degrades to an empty starter list on failure, so one retry is cheaper
    // than an empty chat state.
    retry: { enabled: true, attempts: 2 },
    timeout: REST_TIMEOUT_MS,
  },
};

/**
 * `GET /embed/data/:id`: one Statement Execution result set.
 */
export const statementDataDefaults: ExecuteSettings = {
  default: {
    // Cache enabled: a completed statement's result set is immutable, and the
    // same id is re-fetched every time the transcript re-renders a
    // `[data:<statement_id>]` marker. The entry is namespaced by the caller's
    // identity, so an OBO result never crosses users.
    cache: { enabled: true, ttl: STATEMENT_CACHE_TTL_SEC },
    // Retry enabled: fetching a statement by id is idempotent.
    retry: { enabled: true, attempts: 3 },
    timeout: STATEMENT_TIMEOUT_MS,
  },
};

/**
 * `GET /embed/chart/:id`: the cached chart entry behind a `[chart:<id>]`
 * marker.
 */
export const chartFetchDefaults: ExecuteSettings = {
  default: {
    // Cache disabled: the read long-polls a cache entry that is expected to
    // change from processing to settled, so a cached answer would pin the
    // client to the pre-planner state.
    cache: { enabled: false },
    // Retry disabled: the helper already polls to its own deadline, so a retry
    // would only restart a wait the caller is already inside.
    retry: { enabled: false },
    // No timeout: the poll budget is per request (`?timeoutMs=`, capped by the
    // route) and cancellation rides the connection's abort signal, so a second
    // ceiling here could cut a legitimate long-poll short.
  },
};

/**
 * `POST /route/feedback`: an MLflow trace assessment.
 */
export const feedbackWriteDefaults: ExecuteSettings = {
  default: {
    // Cache disabled: a write, and each submission is a distinct assessment.
    cache: { enabled: false },
    // Retry disabled: posting an assessment is not idempotent (a retry records
    // a duplicate), and `logFeedback` already retries the one recoverable case
    // itself, the trace not having finished exporting to MLflow yet.
    retry: { enabled: false },
    timeout: REST_TIMEOUT_MS,
  },
};
