/**
 * Shared loopback bind defaults for the foreground CLI and tray service.
 *
 * @module
 */

/** Loopback host used when the CLI or service definition omits `--host`. */
export const DEFAULT_HOST = "127.0.0.1";

/** Loopback port used when the CLI or service definition omits `--port`. */
export const DEFAULT_PORT = 4000;

/**
 * High JSON safety ceiling for long agent histories sent to the loopback gateway.
 * Upstream model services and clients remain responsible for their own limits.
 */
export const DEFAULT_BODY_LIMIT = "100mb";
