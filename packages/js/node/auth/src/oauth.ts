import { createHash } from "node:crypto";
import { createServer } from "node:http";

import * as oauth from "oauth4webapi";
import open from "open";

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
  allowInsecureRequests?: boolean;
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

/** Generic OAuth implementation backed by `oauth4webapi`. */
export class OAuthFlow implements TokenProvider {
  private readonly authorizationServer: oauth.AuthorizationServer;
  private readonly client: oauth.Client;
  private readonly clientAuthentication: oauth.ClientAuth;
  private readonly requestOptions: oauth.HttpRequestOptions<string, URLSearchParams>;

  constructor(
    private readonly config: OAuthConfig,
    private readonly grant = OAuthGrant.AuthorizationCode,
  ) {
    if (!config.provider.trim()) throw new AuthError("config", "OAuth provider must not be empty");
    if (!config.tokenEndpoint.trim())
      throw new AuthError("config", "OAuth token endpoint must not be empty");
    if (grant === OAuthGrant.AuthorizationCode && !config.authorizationEndpoint) {
      throw new AuthError("config", "Authorization-code grants require an authorization endpoint");
    }
    this.authorizationServer = {
      issuer: config.host ?? new URL(config.tokenEndpoint).origin,
      authorization_endpoint: config.authorizationEndpoint,
      token_endpoint: config.tokenEndpoint,
    };
    this.client = { client_id: config.clientId };
    this.clientAuthentication = config.clientSecret
      ? oauth.ClientSecretBasic(config.clientSecret)
      : oauth.None();
    this.requestOptions = {
      ...(config.fetch ? { [oauth.customFetch]: config.fetch as typeof globalThis.fetch } : {}),
      ...(config.allowInsecureRequests ? { [oauth.allowInsecureRequests]: true } : {}),
    };
  }

  authenticate(timeoutMs: number): Promise<Token> {
    return this.grant === OAuthGrant.ClientCredentials
      ? this.clientCredentials()
      : this.login(timeoutMs);
  }

  login(timeoutMs: number): Promise<Token> {
    return this.grant === OAuthGrant.ClientCredentials
      ? this.clientCredentials()
      : this.authorizationCode(timeoutMs);
  }

  async refresh(token: Token): Promise<Token> {
    if (this.grant === OAuthGrant.ClientCredentials) return this.clientCredentials();
    if (!token.refreshToken) throw new AuthError("oauth", "Stored credential has no refresh token");
    try {
      const response = await oauth.refreshTokenGrantRequest(
        this.authorizationServer,
        this.client,
        this.clientAuthentication,
        token.refreshToken,
        this.requestOptions,
      );
      return tokenFromResponse(
        await oauth.processRefreshTokenResponse(this.authorizationServer, this.client, response),
        token,
      );
    } catch (cause) {
      throw new AuthError("oauth", "OAuth refresh failed", { cause });
    }
  }

  canAuthenticateSilently(): boolean {
    return this.grant === OAuthGrant.ClientCredentials;
  }

  private async clientCredentials(): Promise<Token> {
    try {
      const response = await oauth.clientCredentialsGrantRequest(
        this.authorizationServer,
        this.client,
        this.clientAuthentication,
        {
          scope: canonicalScopes(this.config.scopes).join(" "),
          ...this.config.extraTokenParams,
        },
        this.requestOptions,
      );
      return tokenFromResponse(
        await oauth.processClientCredentialsResponse(
          this.authorizationServer,
          this.client,
          response,
        ),
      );
    } catch (cause) {
      throw new AuthError("oauth", "OAuth client-credentials request failed", { cause });
    }
  }

  private async authorizationCode(timeoutMs: number): Promise<Token> {
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const state = oauth.generateRandomState();
    const callback = await createCallback(
      timeoutMs,
      this.config.host,
      this.config.callbackImageSrc,
    );
    const authorization = new URL(this.config.authorizationEndpoint!);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", this.config.clientId);
    authorization.searchParams.set("redirect_uri", callback.redirectUri);
    authorization.searchParams.set(
      "scope",
      canonicalScopes(["offline_access", ...(this.config.scopes ?? [])]).join(" "),
    );
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", codeChallenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    try {
      await (this.config.openBrowser ?? openBrowser)(authorization.toString());
      const callbackParameters = oauth.validateAuthResponse(
        this.authorizationServer,
        this.client,
        await callback.parameters,
        state,
      );
      const response = await oauth.authorizationCodeGrantRequest(
        this.authorizationServer,
        this.client,
        oauth.None(),
        callbackParameters,
        callback.redirectUri,
        codeVerifier,
        this.requestOptions,
      );
      return tokenFromResponse(
        await oauth.processAuthorizationCodeResponse(
          this.authorizationServer,
          this.client,
          response,
        ),
      );
    } catch (cause) {
      throw new AuthError("oauth", "OAuth authorization-code flow failed", { cause });
    } finally {
      await callback.close();
    }
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
  await open(url, { wait: false });
}

async function createCallback(
  timeoutMs: number,
  host?: string,
  imageSrc?: string,
): Promise<{ redirectUri: string; parameters: Promise<URLSearchParams>; close(): Promise<void> }> {
  let resolveParameters!: (parameters: URLSearchParams) => void;
  let rejectParameters!: (error: unknown) => void;
  const rawParameters = new Promise<URLSearchParams>((resolve, reject) => {
    resolveParameters = resolve;
    rejectParameters = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    response.writeHead(error ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
    response.end(callbackHtml(host, imageSrc, error ?? undefined));
    resolveParameters(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new AuthError("oauth", "Could not bind OAuth callback server");
  const timeout = setTimeout(
    () => rejectParameters(new AuthError("oauth", "OAuth login timed out")),
    timeoutMs,
  );
  const parameters = rawParameters.finally(() => clearTimeout(timeout));
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    parameters,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function tokenFromResponse(response: oauth.TokenEndpointResponse, previous?: Token): Token {
  return {
    accessToken: response.access_token,
    tokenType: titleTokenType(response.token_type),
    refreshToken: response.refresh_token ?? previous?.refreshToken,
    ...(response.expires_in !== undefined
      ? { expiry: new Date(Date.now() + response.expires_in * 1000).toISOString() }
      : {}),
    scopes: response.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? [],
  };
}

function titleTokenType(value: string): string {
  return value.toLowerCase() === "bearer" ? "Bearer" : value;
}

function callbackHtml(host?: string, imageSrc?: string, error?: string): string {
  const title = error ? "Authentication failed" : "Authenticated";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main>${imageSrc ? `<img alt="dbx tools" src="${escapeHtml(imageSrc)}">` : ""}<h1>${escapeHtml(title)}</h1>${host ? `<p>${escapeHtml(host)}</p>` : ""}${error ? `<p>${escapeHtml(error)}</p>` : ""}<p>You can close this tab.</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
}
