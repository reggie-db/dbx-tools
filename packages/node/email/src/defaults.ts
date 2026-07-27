/**
 * Interceptor defaults and hard payload caps for the email plugin.
 *
 * The execution settings are what the runtime's executor hands
 * `Plugin.execute()`, kept here rather than at the call sites so the
 * caching / retry / timeout posture of every outbound operation is
 * reviewable in one place. The caps bound the one unbounded input the
 * plugin accepts: a model-drafted message with attachments.
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
export type EmailExecuteConfig = {
  cache?: { enabled?: boolean; ttl?: number; cacheKey?: (string | number | object)[] };
  retry?: { enabled?: boolean; attempts?: number; initialDelay?: number; maxDelay?: number };
  timeout?: number;
};

/**
 * The `PluginExecutionSettings` shape accepted by AppKit's `Plugin.execute()`.
 * Mirrored structurally for the same reason as {@link EmailExecuteConfig}.
 */
export type EmailExecutionSettings = {
  default: EmailExecuteConfig;
  user?: EmailExecuteConfig;
};

/** Ceiling on how long a single SMTP conversation may take. */
export const SEND_TIMEOUT_MS = 30_000;

/** Ceiling on the SMTP handshake performed at plugin setup. */
export const VERIFY_TIMEOUT_MS = 15_000;

/** Attempts allowed for the setup-time SMTP handshake, including the first. */
export const VERIFY_ATTEMPTS = 3;

/** Largest single attachment accepted, in decoded bytes (10 MiB). */
export const MAX_ATTACHMENT_BYTES = 10_485_760;

/** Largest combined attachment payload accepted, in decoded bytes (20 MiB). */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20_971_520;

/** Largest number of attachments accepted on one message. */
export const MAX_ATTACHMENT_COUNT = 20;

/** Largest markdown body accepted, in characters. */
export const MAX_BODY_CHARS = 200_000;

/** Execution settings for a send (SMTP dispatch or an outbox write). */
export const EMAIL_SEND_SETTINGS: EmailExecutionSettings = {
  default: {
    // Cache disabled: a send is a side effect, not a value. Replaying a
    // cached result would report success for a message never handed to SMTP.
    cache: { enabled: false },
    // Retry disabled: SMTP delivery is not idempotent. A `sendMail` that
    // times out may already have queued the message, so a second attempt
    // risks delivering the mail twice.
    retry: { enabled: false },
    timeout: SEND_TIMEOUT_MS,
  },
};

/** Execution settings for the setup-time SMTP connectivity check. */
export const EMAIL_VERIFY_SETTINGS: EmailExecutionSettings = {
  default: {
    // Cache disabled: connectivity is a point-in-time fact about the server,
    // and this runs once per boot, so there is nothing to reuse.
    cache: { enabled: false },
    // Retry enabled: the handshake has no side effect, and a cold SMTP relay
    // or a slow DNS answer at boot is exactly the transient failure that
    // should not take the app down.
    retry: { enabled: true, attempts: VERIFY_ATTEMPTS },
    timeout: VERIFY_TIMEOUT_MS,
  },
};

/** Execution settings for the sender-options lookup. */
export const EMAIL_SENDERS_SETTINGS: EmailExecutionSettings = {
  default: {
    // Cache disabled: the options are computed from already-resolved config
    // and the caller's own address, so a cache would add a cross-identity
    // leak risk for no measurable saving.
    cache: { enabled: false },
    // Retry disabled: the lookup performs no I/O, so a failure is
    // deterministic and a second attempt would fail identically.
    retry: { enabled: false },
  },
};
