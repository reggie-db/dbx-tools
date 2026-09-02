/**
 * Google ADC token acquisition through the installed gcloud CLI.
 *
 * gcloud owns login and refresh credentials. The broker receives only the
 * short-lived access token printed by `application-default print-access-token`.
 *
 * @module
 */

import { exec } from "@dbx-tools/core";
import { error, string } from "@dbx-tools/shared-core";

import type { AccessToken, TokenProvider } from "./provider.ts";

/** Google adapter dependencies and conservative token lifetime. */
export interface GoogleProviderOptions {
  /** Lifetime assigned to each freshly printed access token. */
  accessTokenTtlSeconds: number;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable subprocess boundary. */
  execute?: typeof exec.spawn;
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

  constructor(private readonly options: GoogleProviderOptions) {
    this.now = options.now ?? Date.now;
    this.execute = options.execute ?? exec.spawn;
  }

  async acquire(scopes: readonly string[]): Promise<AccessToken> {
    const args = [
      "auth",
      "application-default",
      "print-access-token",
      "--quiet",
      ...(scopes.length > 0 ? [`--scopes=${scopes.join(",")}`] : []),
    ];
    const result = await this.execute("gcloud", args, {
      stdout: "capture",
      stderr: "capture",
      check: false,
    });
    const accessToken = string.trimToNull(result.stdout);
    if (result.exitCode !== 0 || !accessToken) {
      const message = string.trimToNull(result.stderr) ?? `gcloud exited ${result.exitCode}`;
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
