// Default values for the local Databricks model proxy.

/**
 * Loopback address the proxy binds to by default. Keeps the OpenAI-compatible
 * endpoint private to the machine unless the operator explicitly opts into a
 * wider bind (e.g. `0.0.0.0`).
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Default TCP port for the local proxy. */
export const DEFAULT_PORT = 4000;
