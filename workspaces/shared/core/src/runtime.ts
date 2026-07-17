/**
 * Runtime-environment detection. Currently: identify the Databricks App runtime
 * from environment shape. Browser-safe - reads `process.env` off `globalThis`
 * and returns `false` where `process` is absent.
 */

/**
 * Detect the Databricks App runtime from environment shape: requires a
 * non-empty `DATABRICKS_APP_NAME`, a `DATABRICKS_HOST` that parses as an
 * `http`/`https` URL, and a `DATABRICKS_APP_PORT` that is a valid TCP
 * port. Reads `process.env` when no `env` is passed (and safely returns
 * `false` in a browser where `process` is absent).
 */
export function isDatabricksAppEnv(env?: Record<string, string | undefined>): boolean {
  // Read `process.env` off `globalThis` so this stays browser-safe (no `node`
  // types): `process` is absent in a browser, so the lookup yields undefined.
  env ??= (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) {
    return false;
  }
  const appName = env.DATABRICKS_APP_NAME?.trim();
  const host = env.DATABRICKS_HOST?.trim();
  const port = env.DATABRICKS_APP_PORT?.trim();

  if (!appName || !host || !port) {
    return false;
  }

  try {
    const url = new URL(host);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    return false;
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return false;
  }

  return true;
}
