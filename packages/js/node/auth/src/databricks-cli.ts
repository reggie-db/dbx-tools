import { exec } from "@dbx-tools/core";

import { AuthError } from "./errors.ts";
import type { Token, TokenProvider } from "./types.ts";

let available: boolean | undefined;

/** Whether `databricks auth --help` succeeds in this process environment. */
export function databricksCliAvailable(
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
): boolean {
  if (available !== undefined) return available;
  available =
    exec.spawnSync(executable, ["auth", "--help"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  return available;
}

/** Clear the cached CLI availability result, primarily after installation. */
export function resetDatabricksCliAvailability(): void {
  available = undefined;
}

/** Run interactive Databricks CLI login for one profile. */
export async function databricksCliLogin(
  profile: string,
  timeoutMs: number,
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
): Promise<void> {
  const result = await exec.spawn(
    executable,
    ["auth", "login", "--profile", profile, "--timeout", `${Math.ceil(timeoutMs / 1000)}s`],
    { stdin: "inherit", stdout: "inherit", stderr: "capture" },
  );
  if (result.exitCode !== 0)
    throw new AuthError("cli", result.stderr || `databricks auth login exited ${result.exitCode}`);
}

/** Request one profile token from the Databricks CLI. */
export async function databricksCliToken(
  profile: string,
  forceRefresh = false,
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
): Promise<Token> {
  const args = ["auth", "token", "--profile", profile, "--output", "json"];
  if (forceRefresh) args.push("--force-refresh");
  const result = await exec.spawn(executable, args, {
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
  });
  if (result.exitCode !== 0)
    throw new AuthError("cli", result.stderr || `databricks auth token exited ${result.exitCode}`);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (cause) {
    throw new AuthError("cli", "Databricks CLI token output was not JSON", { cause });
  }
  const accessToken = stringValue(value.access_token ?? value.accessToken);
  if (!accessToken) throw new AuthError("cli", "Databricks CLI token output had no access token");
  return {
    accessToken,
    tokenType: stringValue(value.token_type ?? value.tokenType) ?? "Bearer",
    ...(stringValue(value.refresh_token ?? value.refreshToken)
      ? { refreshToken: stringValue(value.refresh_token ?? value.refreshToken) }
      : {}),
    ...(stringValue(value.expiry ?? value.expires_at)
      ? { expiry: stringValue(value.expiry ?? value.expires_at) }
      : {}),
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

/** U2M provider that delegates acquisition and refresh to the Databricks CLI. */
export class DatabricksCliProvider implements TokenProvider {
  constructor(private readonly profile: string) {}

  authenticate(): Promise<Token> {
    return databricksCliToken(this.profile);
  }

  async login(timeoutMs: number): Promise<Token> {
    await databricksCliLogin(this.profile, timeoutMs);
    return databricksCliToken(this.profile);
  }

  refresh(): Promise<Token> {
    return databricksCliToken(this.profile, true);
  }

  canAuthenticateSilently(): boolean {
    return true;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
