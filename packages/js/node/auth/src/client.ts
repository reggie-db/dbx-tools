import type { DatabricksAuthClientInfo } from "@dbx-tools/shared-auth/client";
import { AuthType, TargetKind } from "@dbx-tools/shared-auth/config";
import { DatabricksCliProvider, resolveDatabricksCli } from "./_databricks-cli.ts";
import { AuthError } from "./_errors.ts";
import { publicToken, TokenLifecycle } from "./_lifecycle.ts";
import { authLogger, tokenMetadata } from "./_logging.ts";
import { DatabricksPersonalAccessTokenProvider } from "./_personal-access-token.ts";
import { machineScopes, resolveConfigFile, resolveDatabricksProfile } from "./_profile-config.ts";
import { DatabricksServicePrincipalProvider } from "./_service-principal.ts";
import { MemoryCredentialStore } from "./_storage.ts";
import { type DatabricksProfile, type Token, type TokenProvider } from "./_types.ts";
import {
  AUTH_DEFAULTS,
  type DatabricksAuthOptions,
  DEFAULT_ACCESS_TOKEN_HEADER,
  WORKSPACE_ID_HEADER,
} from "./config.ts";

const logger = authLogger("databricks");

/** Public credential result with no refresh token. */
export interface AccessToken {
  accessToken: string;
  tokenType: string;
  expiry?: string;
  scopes: string[];
}

/** Token acquisition controls. */
export interface TokenOptions {
  /** Permit interactive CLI login when required. */
  login?: boolean;
  /** Bypass a reusable cached token and refresh it. */
  refresh?: boolean;
}

/** WorkspaceClient-shaped Databricks authentication facade. */
export interface AuthClient extends DatabricksAuthClientInfo {
  token(options?: TokenOptions): Promise<AccessToken>;
  headers(options?: TokenOptions): Promise<Record<string, string>>;
  logout(): Promise<void>;
}

/** Injectable host capabilities for Databricks authentication. */
export interface DatabricksAuthDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  resolveCli?: () => Promise<string | undefined>;
}

/** Default Databricks auth facade over the provider-neutral lifecycle. */
class DefaultAuthClient implements AuthClient {
  readonly profile?: string;
  readonly host: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly target: TargetKind;
  readonly authType: AuthType;
  readonly principal: string;

  constructor(
    private readonly profileValue: DatabricksProfile,
    private readonly client?: TokenLifecycle,
    private readonly requestToken?: Token,
  ) {
    this.profile = profileValue.selectedProfile;
    this.host = profileValue.host;
    this.accountId = profileValue.accountId;
    this.workspaceId = profileValue.workspaceId;
    this.target = profileValue.target;
    this.authType = profileValue.authType;
    this.principal = profileValue.principal;
  }

  token(options: TokenOptions = {}) {
    logger.debug("Databricks token requested", {
      ...this.context(),
      login: options.login ?? "auto",
      refresh: options.refresh ?? false,
      source: this.requestToken ? "request" : "lifecycle",
    });
    if (this.requestToken) return Promise.resolve(publicToken(this.requestToken));
    return options.refresh
      ? this.requiredClient().forceRefresh(options.login ?? true)
      : this.requiredClient().tokenWithLogin(options.login);
  }

  async headers(options: TokenOptions = {}): Promise<Record<string, string>> {
    const token = await this.token(options);
    const headers = {
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
      ...(this.profileValue.workspaceId
        ? { [WORKSPACE_ID_HEADER]: this.profileValue.workspaceId }
        : {}),
    };
    logger.debug("generated Databricks authentication headers", {
      ...this.context(),
      headerNames: Object.keys(headers),
      token: tokenMetadata(token),
    });
    return headers;
  }

  logout(): Promise<void> {
    logger.debug("Databricks logout requested", this.context());
    return this.client?.logout() ?? Promise.resolve();
  }

  private requiredClient(): TokenLifecycle {
    if (!this.client) throw new AuthError("oauth", "Authentication lifecycle is not available");
    return this.client;
  }

  private context(): Record<string, unknown> {
    return {
      profile: this.profileValue.name,
      host: this.profileValue.host,
      authType: this.profileValue.authType,
      hasWorkspaceId: Boolean(this.profileValue.workspaceId),
    };
  }
}

/** Create a Databricks authentication client. */
export async function createAuthClient(
  options: DatabricksAuthOptions = {},
  dependencies: DatabricksAuthDependencies = {},
): Promise<AuthClient> {
  return createResolvedAuth(options, dependencies);
}

/** Resolve a Databricks profile and create its token lifecycle. */
async function createResolvedAuth(
  options: DatabricksAuthOptions,
  dependencies: DatabricksAuthDependencies,
): Promise<DefaultAuthClient> {
  const environment = dependencies.environment ?? process.env;
  const profile = resolveDatabricksProfile(options, environment);
  logger.debug("creating Databricks auth", {
    profile: profile.name,
    host: profile.host,
    authType: profile.authType,
  });
  if (profile.authType === AuthType.AppOnBehalfOf) {
    logger.debug("created request-scoped App OBO authentication", {
      profile: profile.name,
      host: profile.host,
      hasWorkspaceId: Boolean(profile.workspaceId),
    });
    return new DefaultAuthClient(profile, undefined, {
      accessToken: profile.accessToken!,
      tokenType: "Bearer",
      scopes: [...profile.scopes],
    });
  }
  const provider = await providerFor(profile, options, dependencies);
  const store = new MemoryCredentialStore();
  const client = new TokenLifecycle(profile.cacheKey, provider, store, {
    ...AUTH_DEFAULTS,
    ...options.auth,
  });
  const auth = new DefaultAuthClient(profile, client);
  logger.debug("created authentication lifecycle", {
    profile: profile.name,
    host: profile.host,
    authType: profile.authType,
  });
  return auth;
}

async function providerFor(
  profile: DatabricksProfile,
  options: DatabricksAuthOptions,
  dependencies: DatabricksAuthDependencies,
): Promise<TokenProvider> {
  const environment = dependencies.environment ?? process.env;
  switch (profile.authType) {
    case AuthType.DatabricksCli: {
      logger.debug("selected Databricks CLI provider", { profile: profile.name });
      return new DatabricksCliProvider(
        profile.name,
        () =>
          dependencies.resolveCli ? dependencies.resolveCli() : resolveDatabricksCli(environment),
        cliEnvironment(profile, resolveConfigFile(options.configFile, environment)),
      );
    }
    case AuthType.PersonalAccessToken:
      logger.debug("selected personal access token provider", { profile: profile.name });
      return new DatabricksPersonalAccessTokenProvider(profile.accessToken!);
    case AuthType.OAuthM2M:
    case AuthType.AppServicePrincipal: {
      logger.debug("selected service-principal provider", {
        profile: profile.name,
        authType: profile.authType,
        target: profile.target,
      });
      const endpoints = await resolveOAuthEndpoints(profile, dependencies.fetch);
      return new DatabricksServicePrincipalProvider({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: profile.clientId,
        clientSecret: profile.clientSecret!,
        scopes: machineScopes(profile.scopes),
        ...(profile.groupId ? { groupId: profile.groupId } : {}),
        allowInsecureRequests: isLoopbackHttp(profile.host),
        fetch: dependencies.fetch,
      });
    }
    case AuthType.AppOnBehalfOf:
      throw new AuthError("config", "App OBO tokens do not use a token provider");
  }
}

interface AuthorizationServer {
  tokenEndpoint: string;
}

async function resolveOAuthEndpoints(
  profile: DatabricksProfile,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthorizationServer> {
  const host = profile.host.replace(/\/$/, "");
  if (profile.target === TargetKind.Account) {
    if (!profile.accountId) throw new AuthError("config", "Account target requires account_id");
    const endpoints = {
      tokenEndpoint: `${host}/oidc/accounts/${profile.accountId}/v1/token`,
    };
    logger.debug("resolved account OAuth endpoint", {
      profile: profile.name,
      tokenOrigin: new URL(endpoints.tokenEndpoint).origin,
    });
    return endpoints;
  }
  const discovery =
    profile.target === TargetKind.Unified
      ? `${host}/oidc/accounts/${requiredAccountId(profile)}/.well-known/oauth-authorization-server`
      : `${host}/oidc/.well-known/oauth-authorization-server`;
  logger.debug("requesting OAuth discovery", {
    profile: profile.name,
    target: profile.target,
    discovery,
  });
  const response = await fetcher(discovery, { redirect: "manual" });
  logger.debug("received OAuth discovery response", {
    profile: profile.name,
    status: response.status,
  });
  if (response.status === 404) {
    throw new AuthError("oauth", `OAuth is not supported at ${discovery}`);
  }
  if (!response.ok) {
    throw new AuthError("oauth", `OAuth discovery returned HTTP ${response.status}`);
  }
  const value = (await response.json()) as Record<string, unknown>;
  const tokenEndpoint = stringValue(value.token_endpoint);
  if (!tokenEndpoint) throw new AuthError("oauth", "OAuth discovery response is incomplete");
  logger.debug("resolved OAuth token endpoint", {
    profile: profile.name,
    tokenOrigin: new URL(tokenEndpoint).origin,
  });
  return { tokenEndpoint };
}

function requiredAccountId(profile: DatabricksProfile): string {
  if (!profile.accountId) throw new AuthError("config", "Unified target requires account_id");
  return profile.accountId;
}

function isLoopbackHttp(host: string): boolean {
  const url = new URL(host);
  return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
}

function cliEnvironment(profile: DatabricksProfile, configFile: string): Record<string, string> {
  return {
    DATABRICKS_CONFIG_FILE: configFile,
    DATABRICKS_CONFIG_PROFILE: profile.name,
    DATABRICKS_HOST: profile.host,
    ...(profile.accountId ? { DATABRICKS_ACCOUNT_ID: profile.accountId } : {}),
    ...(profile.workspaceId ? { DATABRICKS_WORKSPACE_ID: profile.workspaceId } : {}),
    ...(profile.authType === AuthType.PersonalAccessToken
      ? {
          DATABRICKS_AUTH_TYPE: "pat",
          DATABRICKS_TOKEN: profile.accessToken!,
        }
      : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
