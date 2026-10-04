import { homedir } from "node:os";
import { join } from "node:path";

import * as bin from "@dbx-tools/core/bin";
import * as exec from "@dbx-tools/core/exec";
import * as stringUtils from "@dbx-tools/shared-core/string-utils";

import cliAssets from "./generated/databricks-cli-assets.json" with { type: "json" };
import { authLogger, failureMetadata, tokenMetadata } from "./_logging.ts";
import { AuthError } from "./errors.ts";
import type { Token, TokenProvider } from "./types.ts";

const resolutionCache = new Map<string, Promise<string | undefined>>();
const logger = authLogger("cli");

interface DatabricksCliAsset {
  readonly url: string;
  readonly sha256: string;
}

/** Deferred Databricks CLI lookup used by U2M token acquisition. */
export type DatabricksCliResolver = () => Promise<string | undefined>;

/** Controls whether CLI resolution may install the pinned managed executable. */
export interface DatabricksCliResolutionOptions {
  install?: boolean;
}

/** Resolve a compatible Databricks CLI, installing the pinned build asset when needed. */
export function resolveDatabricksCli(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: DatabricksCliResolutionOptions = {},
): Promise<string | undefined> {
  const candidate = stringValue(environment.DATABRICKS_CLI_PATH) ?? "databricks";
  const key = `${candidate}\0${homedir()}\0${process.platform}\0${process.arch}\0${options.install !== false}`;
  const cached = resolutionCache.get(key);
  if (cached) {
    logger.debug("reused Databricks CLI resolution", {
      candidate,
      install: options.install !== false,
    });
    return cached;
  }
  logger.debug("resolving Databricks CLI", {
    candidate,
    install: options.install !== false,
    platform: process.platform,
    arch: process.arch,
    minimumVersion: cliAssets.minimumVersion,
  });
  const resolved = resolveDatabricksCliUncached(candidate, options.install !== false).catch(
    (error) => {
      resolutionCache.delete(key);
      throw error;
    },
  );
  resolutionCache.set(key, resolved);
  return resolved;
}

/** Clear cached CLI resolution, primarily after installation or environment changes. */
export function resetDatabricksCliResolution(): void {
  resolutionCache.clear();
  logger.debug("cleared Databricks CLI resolution cache");
}

async function resolveDatabricksCliUncached(
  candidate: string,
  install: boolean,
): Promise<string | undefined> {
  if (await compatibleDatabricksCli(candidate)) {
    logger.debug("selected installed Databricks CLI", { executable: candidate });
    return candidate;
  }
  const managed = managedExecutable();
  if (await compatibleDatabricksCli(managed)) {
    logger.debug("selected managed Databricks CLI", { executable: managed });
    return managed;
  }
  if (!install) {
    logger.debug("compatible Databricks CLI unavailable and installation disabled");
    return undefined;
  }
  const asset = platformAsset();
  if (!asset) {
    logger.debug("no managed Databricks CLI asset for platform", {
      platform: process.platform,
      arch: process.arch,
    });
    return undefined;
  }
  const root = join(homedir(), ".databricks");
  const binDir = join(root, "bin");
  const executable = managedExecutableName();
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
  logger.debug("ensured managed Databricks CLI", {
    executable: installed.path,
    version: cliAssets.version,
  });
  return installed.path;
}

function managedExecutable(): string {
  return join(homedir(), ".databricks", "bin", managedExecutableName());
}

function managedExecutableName(): string {
  return process.platform === "win32" ? "databricks.exe" : "databricks";
}

async function compatibleDatabricksCli(executable: string): Promise<boolean> {
  try {
    const result = await runProcess(executable, ["--version"], {}, 10_000);
    if (result.exitCode !== 0) {
      logger.debug("Databricks CLI version probe failed", {
        executable,
        exitCode: result.exitCode,
      });
      return false;
    }
    const version = bin.parseVersion(result);
    const compatible =
      version !== undefined && bin.isVersionAtLeast(version, cliAssets.minimumVersion);
    logger.debug("probed Databricks CLI version", {
      executable,
      version: version ?? "unknown",
      minimumVersion: cliAssets.minimumVersion,
      compatible,
    });
    return compatible;
  } catch (cause) {
    logger.debug("Databricks CLI version probe unavailable", {
      executable,
      error: failureMetadata(cause),
    });
    return false;
  }
}

function platformAsset(): DatabricksCliAsset | undefined {
  const key = `${process.platform}-${process.arch}` as keyof typeof cliAssets.assets;
  return cliAssets.assets[key];
}

/** Run interactive Databricks CLI login for one profile. */
export async function databricksCliLogin(
  profile: string,
  timeoutMs: number,
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
  environment: Record<string, string> = {},
): Promise<void> {
  logger.debug("starting Databricks CLI login", { profile, executable, timeoutMs });
  const result = await runProcess(
    executable,
    ["auth", "login", "--profile", profile, "--timeout", `${Math.ceil(timeoutMs / 1000)}s`],
    environment,
  );
  if (result.exitCode !== 0)
    throw new AuthError("cli", result.stderr || `databricks auth login exited ${result.exitCode}`);
  logger.debug("Databricks CLI login completed", { profile, executable });
}

/** Request one profile token from the Databricks CLI. */
export async function databricksCliToken(
  profile: string,
  forceRefresh = false,
  executable = process.env.DATABRICKS_CLI_PATH ?? "databricks",
  environment: Record<string, string> = {},
): Promise<Token> {
  logger.debug("requesting Databricks CLI token", { profile, executable, forceRefresh });
  const args = ["auth", "token", "--profile", profile, "--output", "json"];
  if (forceRefresh) args.push("--force-refresh");
  const result = await runProcess(executable, args, environment);
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
  const token = {
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
  logger.debug("received Databricks CLI token", {
    profile,
    forceRefresh,
    token: tokenMetadata(token),
  });
  return token;
}

async function runProcess(
  command: string,
  args: string[],
  environment: Record<string, string>,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await exec.spawn(command, args, {
      env: { ...process.env, ...environment },
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
      signal: controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Provider that lazily delegates U2M credentials to the Databricks CLI. */
export class DatabricksCliProvider implements TokenProvider {
  private resolution?: Promise<string>;

  constructor(
    private readonly profile: string,
    private readonly executableOrResolver: string | DatabricksCliResolver = () =>
      resolveDatabricksCli(),
    private readonly environment: Record<string, string> = {},
  ) {}

  async authenticate(_timeoutMs: number): Promise<Token> {
    return databricksCliToken(
      this.profile,
      false,
      await this.resolveExecutable(),
      this.environment,
    );
  }

  async login(timeoutMs: number): Promise<Token> {
    const executable = await this.resolveExecutable();
    await databricksCliLogin(this.profile, timeoutMs, executable, this.environment);
    return databricksCliToken(this.profile, false, executable, this.environment);
  }

  async refresh(_token: Token): Promise<Token> {
    return databricksCliToken(this.profile, true, await this.resolveExecutable(), this.environment);
  }

  canAuthenticateSilently(): boolean {
    return true;
  }

  private resolveExecutable(): Promise<string> {
    if (typeof this.executableOrResolver === "string") {
      logger.debug("using configured Databricks CLI executable", {
        profile: this.profile,
        executable: this.executableOrResolver,
      });
      return Promise.resolve(this.executableOrResolver);
    }
    if (this.resolution) {
      logger.debug("reused provider CLI resolution", { profile: this.profile });
      return this.resolution;
    }
    logger.debug("resolving provider CLI lazily", { profile: this.profile });
    this.resolution = this.executableOrResolver()
      .then((executable) => {
        if (!executable)
          throw new AuthError("cli", "Databricks CLI is unavailable on this platform");
        return executable;
      })
      .catch((error) => {
        this.resolution = undefined;
        throw error;
      });
    return this.resolution;
  }
}

function stringValue(value: unknown): string | undefined {
  return stringUtils.trimToNull(value) ?? undefined;
}
