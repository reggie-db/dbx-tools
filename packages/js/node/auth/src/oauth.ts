import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { exec } from "@dbx-tools/core";

import { AuthError } from "./errors.ts";
import { AuthClient } from "./lifecycle.ts";
import { FileCredentialStore } from "./node-storage.ts";
import { MemoryCredentialStore } from "./storage.ts";
import {
  AuthOptions,
  type CredentialStore,
  FileLayout,
  Storage,
  type Token,
  type TokenProvider,
} from "./types.ts";

/** OAuth grant supported by the provider-neutral lifecycle. */
export enum OAuthGrant {
  AuthorizationCode = "authorization-code",
  ClientCredentials = "client-credentials",
}

/** Provider-neutral OAuth endpoints and client configuration. */
export interface OAuthConfig {
  provider: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  extraTokenParams?: Record<string, string>;
  host?: string;
  callbackImageSrc?: string;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<void>;
}

/** Persistent generic OAuth provider options. */
export interface ProviderOptions extends OAuthConfig {
  profile?: string;
  grant?: OAuthGrant;
  cacheDir?: string;
  storage?: Storage;
  fileLayout?: FileLayout;
  auth?: AuthOptions;
}

/** Generic OAuth implementation shared by Databricks U2M and M2M. */
export class OAuthFlow implements TokenProvider {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly config: OAuthConfig, private readonly grant = OAuthGrant.AuthorizationCode) {
    this.fetcher = config.fetch ?? globalThis.fetch;
    if (!config.provider.trim()) throw new AuthError("config", "OAuth provider must not be empty");
    if (!config.tokenEndpoint.trim()) throw new AuthError("config", "OAuth token endpoint must not be empty");
    if (grant === OAuthGrant.AuthorizationCode && !config.authorizationEndpoint) {
      throw new AuthError("config", "Authorization-code grants require an authorization endpoint");
    }
  }

  authenticate(timeoutMs: number): Promise<Token> {
    return this.grant === OAuthGrant.ClientCredentials ? this.clientCredentials() : this.login(timeoutMs);
  }

  login(timeoutMs: number): Promise<Token> {
    return this.grant === OAuthGrant.ClientCredentials ? this.clientCredentials() : this.authorizationCode(timeoutMs);
  }

  refresh(token: Token): Promise<Token> {
    if (this.grant === OAuthGrant.ClientCredentials) return this.clientCredentials();
    if (!token.refreshToken) throw new AuthError("oauth", "Stored credential has no refresh token");
    return this.requestToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: this.config.clientId,
      },
      token,
    );
  }

  canAuthenticateSilently(): boolean {
    return this.grant === OAuthGrant.ClientCredentials;
  }

  private async clientCredentials(): Promise<Token> {
    return this.requestToken(
      {
        grant_type: "client_credentials",
        scope: canonicalScopes(this.config.scopes).join(" "),
        ...this.config.extraTokenParams,
      },
      undefined,
      true,
    );
  }

  private async authorizationCode(timeoutMs: number): Promise<Token> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const callback = await createCallback(timeoutMs, state, this.config.host, this.config.callbackImageSrc);
    const authorization = new URL(this.config.authorizationEndpoint!);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", this.config.clientId);
    authorization.searchParams.set("redirect_uri", callback.redirectUri);
    authorization.searchParams.set("scope", canonicalScopes(["offline_access", ...(this.config.scopes ?? [])]).join(" "));
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    try {
      await (this.config.openBrowser ?? openBrowser)(authorization.toString());
      const code = await callback.code;
      return await this.requestToken({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: verifier,
      });
    } finally {
      await callback.close();
    }
  }

  private async requestToken(
    parameters: Record<string, string>,
    previous?: Token,
    basicAuth = false,
  ): Promise<Token> {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (basicAuth) {
      if (!this.config.clientSecret) throw new AuthError("config", "Client credentials require a client secret");
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      );
    }
    const response = await this.fetcher(this.config.tokenEndpoint, {
      method: "POST",
      headers,
      body: new URLSearchParams(parameters),
      redirect: "manual",
    });
    const text = await response.text();
    if (!response.ok) throw new AuthError("oauth", `OAuth token endpoint returned HTTP ${response.status}: ${text}`);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch (cause) {
      throw new AuthError("oauth", "OAuth token endpoint did not return JSON", { cause });
    }
    const accessToken = stringValue(value.access_token);
    if (!accessToken) throw new AuthError("oauth", "OAuth token response did not contain an access token");
    const expiresIn = numberValue(value.expires_in);
    const scopes = Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string")
      : typeof value.scope === "string"
        ? value.scope.split(/\s+/).filter(Boolean)
        : previous?.scopes ?? canonicalScopes(this.config.scopes);
    return {
      accessToken,
      tokenType: stringValue(value.token_type) ?? "Bearer",
      refreshToken: stringValue(value.refresh_token) ?? previous?.refreshToken,
      ...(expiresIn !== undefined ? { expiry: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
      scopes,
    };
  }
}

/** Persistent generic OAuth facade using the same lifecycle as Databricks auth. */
export class ProviderAuth {
  constructor(private readonly client: AuthClient) {}

  token(login?: boolean) {
    return this.client.tokenWithLogin(login);
  }

  forceRefreshToken(login = true) {
    return this.client.forceRefresh(login);
  }

  refreshRejectedToken(staleAccessToken: string, login = true) {
    return this.client.refreshRejectedToken(staleAccessToken, login);
  }

  logout() {
    return this.client.logout();
  }
}

/** Construct a provider with built-in persistent storage. */
export async function createProviderAuth(
  options: ProviderOptions,
  store?: CredentialStore,
): Promise<ProviderAuth> {
  const auth = AuthOptions.create(options.auth);
  const scopes = canonicalScopes(options.scopes);
  const identity = JSON.stringify([options.provider, options.profile ?? "default", scopes]);
  const key = `${options.provider}-${createHash("sha256").update(identity).digest("hex")}`;
  const selectedStore =
    store ??
    (options.storage === Storage.Memory
      ? new MemoryCredentialStore()
      : new FileCredentialStore(options.cacheDir, options.fileLayout));
  const flow = new OAuthFlow(options, options.grant);
  return new ProviderAuth(new AuthClient(key, flow, selectedStore, auth));
}

export function canonicalScopes(scopes: readonly string[] | undefined): string[] {
  return [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))].sort();
}

async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const result = await exec.spawn(command, args, { stdout: "ignore", stderr: "capture" });
  if (result.exitCode !== 0) throw new AuthError("oauth", `Could not open browser: ${result.stderr}`);
}

async function createCallback(
  timeoutMs: number,
  expectedState: string,
  host?: string,
  imageSrc?: string,
): Promise<{ redirectUri: string; code: Promise<string>; close(): Promise<void> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const rawCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const error = url.searchParams.get("error");
    const description = url.searchParams.get("error_description");
    if (url.searchParams.get("state") !== expectedState) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(callbackHtml(host, imageSrc, "Invalid OAuth state"));
      rejectCode(new AuthError("oauth", "OAuth callback state did not match"));
      return;
    }
    if (error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(callbackHtml(host, imageSrc, description ?? error));
      rejectCode(new AuthError("oauth", description ?? error));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(callbackHtml(host, imageSrc, "OAuth callback did not include a code"));
      rejectCode(new AuthError("oauth", "OAuth callback did not include a code"));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(callbackHtml(host, imageSrc));
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new AuthError("oauth", "Could not bind OAuth callback server");
  const timeout = setTimeout(() => rejectCode(new AuthError("oauth", "OAuth login timed out")), timeoutMs);
  const code = rawCode.finally(() => clearTimeout(timeout));
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function callbackHtml(host?: string, imageSrc?: string, error?: string): string {
  const title = error ? "Authentication failed" : "Authenticated";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main>${imageSrc ? `<img alt="dbx tools" src="${escapeHtml(imageSrc)}">` : ""}<h1>${escapeHtml(title)}</h1>${host ? `<p>${escapeHtml(host)}</p>` : ""}${error ? `<p>${escapeHtml(error)}</p>` : ""}<p>You can close this tab.</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!);
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
