/**
 * Shared loopback bind defaults for the foreground CLI and tray service.
 *
 * @module
 */

/** Loopback host used when the CLI or service definition omits `--host`. */
export const DEFAULT_HOST = "127.0.0.1";

/** Loopback port used when the CLI or service definition omits `--port`. */
export const DEFAULT_PORT = 4000;
