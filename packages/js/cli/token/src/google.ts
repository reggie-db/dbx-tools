/**
 * Google ADC token acquisition through the installed gcloud CLI.
 *
 * gcloud owns login and refresh credentials. The broker receives only the
 * short-lived access token printed by `application-default print-access-token`.
 *
 * @module
 */

import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { bin, exec } from "@dbx-tools/core";
import { error, functionModule, string } from "@dbx-tools/shared-core";

import type { AccessToken, TokenProvider } from "./provider.ts";

const resolveGcloudExecutable = functionModule.memoize(async () => {
  const executable = await bin.which("gcloud", {
    defaultLocations: true,
    locations: gcloudLocations(process.platform, homedir(), process.env),
  });
  if (executable) return executable;
  throw new Error(
    `gcloud executable was not found on PATH or in common ${process.platform} install locations`,
  );
});

/** Google adapter dependencies and conservative token lifetime. */
export interface GoogleProviderOptions {
  /** Lifetime assigned to each freshly printed access token. */
  accessTokenTtlSeconds: number;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable subprocess boundary. */
  execute?: typeof exec.spawn;
  /** Injectable gcloud executable resolver. */
  resolveExecutable?: () => string | Promise<string>;
}

function gcloudLocations(
  platform: NodeJS.Platform,
  home: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  const configured = [environment.CLOUDSDK_ROOT_DIR, environment.GCLOUD_HOME]
    .filter((path): path is string => Boolean(path))
    .map((path) => join(path, "bin"));
  if (platform === "darwin") {
    return [
      ...configured,
      "/opt/homebrew/share/google-cloud-sdk/bin",
      "/usr/local/share/google-cloud-sdk/bin",
      "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin",
      "/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin",
      join(home, "google-cloud-sdk", "bin"),
    ];
  }
  if (platform === "linux") {
    return [
      ...configured,
      "/opt/google-cloud-sdk/bin",
      "/usr/lib/google-cloud-sdk/bin",
      join(home, "google-cloud-sdk", "bin"),
    ];
  }
  if (platform === "win32") {
    const roots = [
      environment.LOCALAPPDATA,
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"],
      win32.join(home, "AppData", "Local"),
    ].filter((path): path is string => Boolean(path));
    return [
      ...configured,
      ...roots.map((root) => win32.join(root, "Google", "Cloud SDK", "google-cloud-sdk", "bin")),
    ];
  }
  return configured;
}

/**
 * Google provider that delegates credential ownership to gcloud ADC.
 *
 * Empty scopes intentionally omit the gcloud `--scopes` flag. Explicit scopes
 * are passed verbatim after broker canonicalization and must already belong to
 * the ADC login grant.
 */
export class GoogleTokenProvider implements TokenProvider {
  readonly name = "google";
  private readonly now: () => number;
  private readonly execute: typeof exec.spawn;
  private readonly resolveExecutable: () => Promise<string>;

  constructor(private readonly options: GoogleProviderOptions) {
    this.now = options.now ?? Date.now;
    this.execute = options.execute ?? exec.spawn;
    const resolveExecutable = options.resolveExecutable ?? resolveGcloudExecutable;
    this.resolveExecutable = async () => resolveExecutable();
  }

  async acquire(scopes: readonly string[]): Promise<AccessToken> {
    const args = [
      "auth",
      "application-default",
      "print-access-token",
      "--quiet",
      ...(scopes.length > 0 ? [`--scopes=${scopes.join(",")}`] : []),
    ];
    let executable: string;
    try {
      executable = await this.resolveExecutable();
    } catch (cause) {
      throw new Error(`Google ADC access token failed: ${error.errorMessage(cause)}`, {
        cause,
      });
    }
    const result = await this.execute(executable, args, {
      stdout: "capture",
      stderr: "capture",
      check: false,
      ...(process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")
        ? { shell: true }
        : {}),
    });
    const accessToken = string.trimToNull(result.stdout);
    if (result.exitCode !== 0 || !accessToken) {
      const message = string.trimToNull(result.stderr) ?? `${executable} exited ${result.exitCode}`;
      throw new Error(`Google ADC access token failed: ${error.errorMessage(message)}`);
    }
    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt: this.now() + this.options.accessTokenTtlSeconds * 1000,
      scopes: [...scopes],
    };
  }
}
