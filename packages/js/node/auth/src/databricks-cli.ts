import { homedir } from "node:os";
import { join } from "node:path";

import { bin } from "@dbx-tools/core";
import { process as processBinding } from "@dbx-tools/bindings";
import { stringUtils } from "@dbx-tools/shared-core";

import cliAssets from "./generated/databricks-cli-assets.json" with { type: "json" };
import { AuthError } from "./errors.ts";
import type { Token, TokenProvider } from "./types.ts";

const resolutionCache = new Map<string, Promise<string | undefined>>();

interface DatabricksCliAsset {
  readonly url: string;
  readonly sha256: string;
}

/** Resolve a compatible Databricks CLI, installing the pinned build asset when needed. */
export function resolveDatabricksCli(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  const candidate = stringValue(environment.DATABRICKS_CLI_PATH) ?? "databricks";
  const key = `${candidate}\0${homedir()}\0${process.platform}\0${process.arch}`;
  const cached = resolutionCache.get(key);
  if (cached) return cached;
  const resolved = resolveDatabricksCliUncached(candidate).catch((error) => {
    resolutionCache.delete(key);
    throw error;
  });
  resolutionCache.set(key, resolved);
  return resolved;
}

/** Clear cached CLI resolution, primarily after installation or environment changes. */
export function resetDatabricksCliResolution(): void {
  resolutionCache.clear();
}

async function resolveDatabricksCliUncached(candidate: string): Promise<string | undefined> {
  if (await compatibleDatabricksCli(candidate)) return candidate;
  const asset = platformAsset();
  if (!asset) return undefined;
  const root = join(homedir(), ".databricks");
  const binDir = join(root, "bin");
  const executable = process.platform === "win32" ? "databricks.exe" : "databricks";
  const installed = await bin.ensure("databricks", asset, {
    autoUnpackage: true,
    destination: { root, binDir, path: join(binDir, executable) },
    minVersion: cliAssets.minimumVersion,
    selector: ({ source }) => join(source, executable),
    versionParser: (output) => {
      const version = bin.parseVersion(output);
      return version === cliAssets.version ? version : undefined;
    },
  });
  return installed.path;
}

async function compatibleDatabricksCli(executable: string): Promise<boolean> {
  try {
    const result = await processBinding.runProcess({
      command: executable,
      args: ["--version"],
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return false;
    const version = bin.parseVersion({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    return version !== undefined && compareVersion(version, cliAssets.minimumVersion) >= 0;
  } catch {
    return false;
  }
}

function platformAsset(): DatabricksCliAsset | undefined {
  const key = `${process.platform}-${process.arch}` as keyof typeof cliAssets.assets;
  return cliAssets.assets[key];
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Run interactive Databricks CLI login for one profile. */
export async function databricksCliLogin(
  profile: string,
  timeoutMs: number,
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
): Promise<void> {
  const result = await processBinding.runProcess({
    command: executable,
    args: ["auth", "login", "--profile", profile, "--timeout", `${Math.ceil(timeoutMs / 1000)}s`],
  });
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
  const result = await processBinding.runProcess({ command: executable, args });
  if (result.exitCode !== 0)
    throw new AuthError("cli", result.stderr || `databricks auth token exited ${result.exitCode}`);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
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
  constructor(
    private readonly profile: string,
    private readonly executable: string,
  ) {}

  authenticate(): Promise<Token> {
    return databricksCliToken(this.profile, false, this.executable);
  }

  async login(timeoutMs: number): Promise<Token> {
    await databricksCliLogin(this.profile, timeoutMs, this.executable);
    return databricksCliToken(this.profile, false, this.executable);
  }

  refresh(): Promise<Token> {
    return databricksCliToken(this.profile, true, this.executable);
  }

  canAuthenticateSilently(): boolean {
    return true;
  }
}

function stringValue(value: unknown): string | undefined {
  return stringUtils.trimToNull(value) ?? undefined;
}
