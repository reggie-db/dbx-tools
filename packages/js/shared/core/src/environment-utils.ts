import { MAX_TCP_PORT } from "./net.ts";
import { toBoolean } from "./object.ts";

/** Databricks Apps container working tree used when App env vars are not yet injected. */
export const DATABRICKS_APP_SOURCE_ROOT = "/app/python/source_code";

function runtimeProcess():
  | { env?: Record<string, string | undefined>; cwd?: () => string }
  | undefined {
  return (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined>; cwd?: () => string };
    }
  ).process;
}

function runtimeEnvironment(): Record<string, string | undefined> {
  return runtimeProcess()?.env ?? {};
}

function runtimeCwd(): string {
  return runtimeProcess()?.cwd?.() ?? "";
}

function isDatabricksAppSourceTree(cwd: string): boolean {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalized === DATABRICKS_APP_SOURCE_ROOT ||
    normalized.startsWith(`${DATABRICKS_APP_SOURCE_ROOT}/`)
  );
}

function hasDatabricksAppEnv(source: Record<string, string | undefined>): boolean {
  const name = source.DATABRICKS_APP_NAME?.trim();
  const host = source.DATABRICKS_HOST?.trim();
  const port = source.DATABRICKS_APP_PORT?.trim();
  if (!host || (!name && !port) || (name && /\$\{[^}]+\}/.test(name))) return false;
  if (port) {
    if (!/^\d+$/.test(port)) return false;
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > MAX_TCP_PORT) return false;
  }
  try {
    const url = new URL(host);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Detect a Databricks App runtime from its workspace host plus App name or port,
 * or from the Apps container source tree when those variables are not yet set.
 *
 * `DBX_TOOLS_DATABRICKS_APP_ENV` takes precedence when it contains a recognized
 * boolean value. This lets local tools emulate the deployed runtime (`true`) or
 * lets unusual deployed processes retain local config lookup (`false`). An
 * absent or unrecognized override falls back to structural detection.
 */
export function isDatabricksAppEnv(
  source: Record<string, string | undefined> = runtimeEnvironment(),
  cwd: string = runtimeCwd(),
): boolean {
  const override = toBoolean(source.DBX_TOOLS_DATABRICKS_APP_ENV);
  if (override !== undefined) return override;
  return hasDatabricksAppEnv(source) || isDatabricksAppSourceTree(cwd);
}
