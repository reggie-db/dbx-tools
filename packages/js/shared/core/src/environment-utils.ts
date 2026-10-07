import { MAX_TCP_PORT } from "./net.ts";
import { toBoolean } from "./object.ts";

function runtimeEnvironment(): Record<string, string | undefined> {
  return (
    (
      globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env ?? {}
  );
}

/** Detect a Databricks App runtime from its required host and App-specific port. */
export function isDatabricksAppEnv(
  source: Record<string, string | undefined> = runtimeEnvironment(),
): boolean {
  const override = toBoolean(source.DBX_TOOLS_DATABRICKS_APP_ENV);
  if (override !== undefined) return override;
  const name = source.DATABRICKS_APP_NAME?.trim();
  const host = source.DATABRICKS_HOST?.trim();
  const port = source.DATABRICKS_APP_PORT?.trim();
  if ((name && /\$\{[^}]+\}/.test(name)) || !host || !port || !/^\d+$/.test(port)) return false;
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > MAX_TCP_PORT) return false;
  try {
    const url = new URL(host);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
