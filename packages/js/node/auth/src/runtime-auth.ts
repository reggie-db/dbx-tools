import { RUNTIME_AUTH_TYPE } from "@dbx-tools/shared-auth/client";
import { TargetKind } from "@dbx-tools/shared-auth/config";
import { getAccessTokenPayload, getAccessTokenScopes } from "@dbx-tools/shared-core/token";

import { AuthError } from "./_errors.ts";
import { TokenLifecycle } from "./_lifecycle.ts";
import { normalizeHost } from "./_profile-config.ts";
import { MemoryCredentialStore } from "./_storage.ts";
import type { Token, TokenProvider } from "./_types.ts";
import type { AccessToken, AuthClient, TokenOptions } from "./client.ts";
import {
  AUTH_DEFAULTS,
  type DatabricksAuthOptions,
  DEFAULT_ACCESS_TOKEN_HEADER,
  WORKSPACE_ID_HEADER,
} from "./config.ts";

const MINIMUM_RUNTIME_TOKEN_TTL_MS = 60_000;
const RUNTIME_PRINCIPAL = "runtime";

/** Python runtime authentication operations backed by one SDK WorkspaceClient. */
export interface DatabricksRuntimeAuthClient {
  /** Resolved Databricks workspace URL. */
  readonly host: string;
  /** Resolved workspace identifier when the Python SDK provides one. */
  readonly workspaceId?: string;
  /** Resolved caller identifier when the Python SDK provides one. */
  readonly principal?: string;
  /** Return the Python SDK's directly configured token, when present. */
  token(): Promise<string | undefined>;
  /** Return fresh authentication headers from the Python SDK. */
  authenticate(): Promise<Record<string, string>>;
}

interface PythonNodeRuntime {
  databricksRuntimeAuthClient?(): Promise<DatabricksRuntimeAuthClient | undefined>;
}

/**
 * Return auth installed by the shared Python Node runtime, when available.
 */
export async function _databricksRuntimeAuthClient(): Promise<
  DatabricksRuntimeAuthClient | undefined
> {
  const runtime = (
    globalThis as typeof globalThis & {
      [key: symbol]: PythonNodeRuntime | undefined;
    }
  )[Symbol.for("@dbx-tools/node-runtime/runtime")];
  return runtime?.databricksRuntimeAuthClient?.();
}

/** Create an auth facade over a Python runtime WorkspaceClient. */
export function createDatabricksRuntimeAuthClient(
  runtime: DatabricksRuntimeAuthClient,
  options: DatabricksAuthOptions,
): AuthClient {
  const lifecycleOptions = {
    ...AUTH_DEFAULTS,
    ...options.auth,
  };
  const provider = new DatabricksRuntimeTokenProvider(runtime, lifecycleOptions.refreshBufferMs);
  const lifecycle = new TokenLifecycle(
    runtimeCacheKey(runtime),
    provider,
    new MemoryCredentialStore(),
    lifecycleOptions,
  );
  return new DefaultDatabricksRuntimeAuthClient(runtime, provider, lifecycle);
}

function runtimeCacheKey(runtime: DatabricksRuntimeAuthClient): string {
  return [
    RUNTIME_AUTH_TYPE,
    normalizeHost(runtime.host, RUNTIME_PRINCIPAL),
    runtime.workspaceId ?? "",
    runtime.principal ?? "",
  ].join(":");
}

function normalizedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function runtimeToken(
  headers: Readonly<Record<string, string>>,
  refreshBufferMs: number,
  configuredToken?: string,
): Token {
  const authorization = headers[DEFAULT_ACCESS_TOKEN_HEADER];
  const match = authorization?.trim().match(/^(\S+)\s+(.+)$/);
  const accessToken = match?.[2]?.trim() || configuredToken?.trim();
  if (!accessToken) {
    throw new AuthError(
      "oauth",
      "Databricks Python runtime authentication did not provide an access token",
    );
  }
  const payload = getAccessTokenPayload(accessToken);
  const jwtExpiry =
    typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? new Date(payload.exp * 1000).toISOString()
      : undefined;
  // Opaque runtime credentials still need a bounded Node cache. Reacquire them
  // from the Python SDK after one refresh-buffer interval.
  const expiry =
    jwtExpiry ??
    new Date(
      Date.now() + Math.max(refreshBufferMs * 2, MINIMUM_RUNTIME_TOKEN_TTL_MS),
    ).toISOString();
  return {
    accessToken,
    tokenType: match?.[1] || "Bearer",
    ...(expiry ? { expiry } : {}),
    scopes: [...getAccessTokenScopes(accessToken)],
  };
}

class DatabricksRuntimeTokenProvider implements TokenProvider {
  #accessToken?: string;
  #headers?: Record<string, string>;

  constructor(
    private readonly runtime: DatabricksRuntimeAuthClient,
    private readonly refreshBufferMs: number,
  ) {}

  authenticate(): Promise<Token> {
    return this.acquire();
  }

  login(): Promise<Token> {
    return this.acquire();
  }

  refresh(): Promise<Token> {
    return this.acquire();
  }

  canAuthenticateSilently(): boolean {
    return true;
  }

  headers(token: AccessToken): Record<string, string> {
    if (this.#accessToken === token.accessToken && this.#headers) {
      return { ...this.#headers };
    }
    return {
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
    };
  }

  clear(): void {
    this.#accessToken = undefined;
    this.#headers = undefined;
  }

  private async acquire(): Promise<Token> {
    const headers = normalizedHeaders(await this.runtime.authenticate());
    const token = runtimeToken(headers, this.refreshBufferMs, await this.runtime.token());
    this.#accessToken = token.accessToken;
    this.#headers = {
      ...headers,
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
    };
    return token;
  }
}

class DefaultDatabricksRuntimeAuthClient implements AuthClient {
  readonly profile = undefined;
  readonly host: string;
  readonly accountId = undefined;
  readonly workspaceId?: string;
  readonly target = TargetKind.Workspace;
  readonly authType = RUNTIME_AUTH_TYPE;
  readonly principal: string;

  constructor(
    runtime: DatabricksRuntimeAuthClient,
    private readonly provider: DatabricksRuntimeTokenProvider,
    private readonly lifecycle: TokenLifecycle,
  ) {
    this.host = normalizeHost(runtime.host, RUNTIME_PRINCIPAL);
    this.workspaceId = runtime.workspaceId;
    this.principal = runtime.principal || RUNTIME_PRINCIPAL;
  }

  token(options: TokenOptions = {}): Promise<AccessToken> {
    return options.refresh
      ? this.lifecycle.forceRefresh(options.login ?? true)
      : this.lifecycle.tokenWithLogin(options.login);
  }

  async headers(options: TokenOptions = {}): Promise<Record<string, string>> {
    const headers = this.provider.headers(await this.token(options));
    if (this.workspaceId && headers[WORKSPACE_ID_HEADER] === undefined) {
      headers[WORKSPACE_ID_HEADER] = this.workspaceId;
    }
    return headers;
  }

  async logout(): Promise<void> {
    await this.lifecycle.logout();
    this.provider.clear();
  }
}
