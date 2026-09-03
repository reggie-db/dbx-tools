/**
 * Google ADC token acquisition through the installed gcloud CLI.
 *
 * gcloud owns login and refresh credentials. The broker receives only the
 * short-lived access token printed by `application-default print-access-token`.
 *
 * @module
 */

import { exec, processLock } from "@dbx-tools/core";
import { error, json, string } from "@dbx-tools/shared-core";

import { canonicalScopes } from "./config.ts";
import type { AccessToken, TokenProvider } from "./provider.ts";

const TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const ADC_SCOPE_AUTHORIZATION_LOCK = ["token-broker", "google", "adc-scope-authorization"];
const INVALID_SCOPES_PATTERN = /Invalid (?:value for \[--scopes\]|scopes value)/i;

/** Google adapter dependencies and conservative token lifetime. */
export interface GoogleProviderOptions {
  /** Lifetime assigned to each freshly printed access token. */
  accessTokenTtlSeconds: number;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable subprocess boundary. */
  execute?: typeof exec.spawn;
  /** gcloud command or absolute executable path. */
  executable?: string;
  /** Injectable token-info HTTP boundary. */
  fetch?: typeof globalThis.fetch;
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
  private readonly executable: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: GoogleProviderOptions) {
    this.now = options.now ?? Date.now;
    this.execute = options.execute ?? exec.spawn;
    this.executable = options.executable ?? "gcloud";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async acquire(scopes: readonly string[]): Promise<AccessToken> {
    const result = await this.printAccessToken(scopes);
    const token = this.accessToken(result, scopes);
    if (token) return token;
    if (scopes.length === 0 || !this.invalidScopes(result)) {
      throw this.accessTokenError(result);
    }
    return processLock.withProcessLock(ADC_SCOPE_AUTHORIZATION_LOCK, async () => {
      const retried = await this.printAccessToken(scopes);
      const retriedToken = this.accessToken(retried, scopes);
      if (retriedToken) return retriedToken;
      if (!this.invalidScopes(retried)) throw this.accessTokenError(retried);

      const current = await this.printAccessToken([]);
      const currentToken = this.accessToken(current, []);
      if (!currentToken) throw this.accessTokenError(current);
      const currentScopes = await this.currentScopes(currentToken.accessToken);
      const granted = new Set(currentScopes);
      if (scopes.every((scope) => granted.has(scope))) {
        return { ...currentToken, scopes: [...scopes] };
      }

      const combinedScopes = canonicalScopes([...currentScopes, ...scopes]);
      const login = await this.execute(
        this.executable,
        [
          "auth",
          "application-default",
          "login",
          "--quiet",
          "--launch-browser",
          `--scopes=${combinedScopes.join(",")}`,
        ],
        this.executeOptions(),
      );
      if (login.exitCode !== 0) {
        const message =
          string.trimToNull(login.stderr) ?? `${this.executable} exited ${login.exitCode}`;
        throw new Error(`Google ADC scope authorization failed: ${error.errorMessage(message)}`);
      }

      const authorized = await this.printAccessToken(scopes);
      const authorizedToken = this.accessToken(authorized, scopes);
      if (!authorizedToken) throw this.accessTokenError(authorized);
      return authorizedToken;
    });
  }

  private printAccessToken(scopes: readonly string[]) {
    const args = [
      "auth",
      "application-default",
      "print-access-token",
      "--quiet",
      ...(scopes.length > 0 ? [`--scopes=${scopes.join(",")}`] : []),
    ];
    return this.execute(this.executable, args, this.executeOptions());
  }

  private executeOptions() {
    return {
      stdout: "capture",
      stderr: "capture",
      check: false,
      ...(process.platform === "win32" && this.executable.toLowerCase().endsWith(".cmd")
        ? { shell: true }
        : {}),
    } as const;
  }

  private accessToken(
    result: Awaited<ReturnType<typeof exec.spawn>>,
    scopes: readonly string[],
  ): AccessToken | undefined {
    const accessToken = string.trimToNull(result.stdout);
    if (result.exitCode !== 0 || !accessToken) return undefined;
    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt: this.now() + this.options.accessTokenTtlSeconds * 1000,
      scopes: [...scopes],
    };
  }

  private accessTokenError(result: Awaited<ReturnType<typeof exec.spawn>>): Error {
    const message =
      string.trimToNull(result.stderr) ?? `${this.executable} exited ${result.exitCode}`;
    return new Error(`Google ADC access token failed: ${error.errorMessage(message)}`);
  }

  private invalidScopes(result: Awaited<ReturnType<typeof exec.spawn>>): boolean {
    return result.exitCode !== 0 && INVALID_SCOPES_PATTERN.test(result.stderr);
  }

  private async currentScopes(accessToken: string): Promise<string[]> {
    try {
      const response = await this.fetch(TOKEN_INFO_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body = json.parseRecord(await response.text()) ?? {};
      if (!response.ok) {
        const message =
          string.trimToNull(body.error_description) ??
          string.trimToNull(body.error) ??
          `tokeninfo returned ${response.status}`;
        throw new Error(message);
      }
      return canonicalScopes(string.parseList(string.trimToNull(body.scope)));
    } catch (cause) {
      throw new Error(`Google ADC scope inspection failed: ${error.errorMessage(cause)}`, {
        cause,
      });
    }
  }
}
